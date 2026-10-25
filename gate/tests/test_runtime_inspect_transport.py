"""Exercise the production inspect decoder with substituted HTTP responses only."""
from contextlib import contextmanager
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from gate.engine import DockerError, DockerTimeout, Engine


@contextmanager
def inspect_response(status, body=b'', *, read=None):
    response = SimpleNamespace(status=status, read=read if read is not None else lambda limit: body[:limit])
    with patch('gate.engine.UnixConnection') as connection:
        connection.return_value.sock = None
        connection.return_value.getresponse.return_value = response
        yield Engine(path='/unused-test-socket')


class InspectTransportTests(unittest.TestCase):
    def test_only_http_404_reports_missing(self):
        with inspect_response(404, b'{"message":"No such container"}') as engine:
            self.assertIsNone(engine.inspect('1' * 64, timeout=1))

    def test_http_404_inspect_does_not_read_stalled_error_body(self):
        read = Mock(side_effect=TimeoutError('private daemon body'))
        with inspect_response(404, read=read) as engine:
            try:
                result = engine.inspect('1' * 64, timeout=1)
            except DockerError as error:
                self.fail('confirmed missing helper became %s' % type(error).__name__)
        self.assertIsNone(result)
        read.assert_not_called()

    def test_http_errors_precede_stalled_body_and_suppress_content(self):
        for status, inspect in ((500, True), (404, False), (500, False)):
            with self.subTest(status=status, inspect=inspect):
                read = Mock(side_effect=TimeoutError('private daemon body'))
                with inspect_response(status, read=read) as engine:
                    with self.assertRaises(DockerError) as caught:
                        if inspect:
                            engine.inspect('1' * 64, timeout=1)
                        else:
                            engine.call('GET', '/containers/test/logs?stdout=1&stderr=1',
                                        response_raw=True, timeout=1)
                self.assertIs(type(caught.exception), DockerError)
                self.assertIn('HTTP %d' % status, str(caught.exception))
                self.assertNotIn('private daemon body', str(caught.exception))
                read.assert_not_called()

    def test_successful_response_body_timeout_remains_typed(self):
        read = Mock(side_effect=TimeoutError('private daemon body'))
        with inspect_response(200, read=read) as engine:
            with self.assertRaises(DockerTimeout) as caught:
                engine.inspect('1' * 64, timeout=1)
        self.assertNotIn('private daemon body', str(caught.exception))

    def test_successful_inspect_rejects_empty_null_and_non_objects(self):
        for body in (b'', b'null', b'[]', b'false', b'42', b'"text"', b'{}'):
            with self.subTest(body=body), inspect_response(200, body) as engine:
                with self.assertRaises(DockerError):
                    engine.inspect('1' * 64, timeout=1)

    def test_successful_object_is_preserved(self):
        with inspect_response(200, b'{"Id":"immutable","State":{"Running":true}}') as engine:
            self.assertEqual(engine.inspect('1' * 64, timeout=1),
                             {'Id': 'immutable', 'State': {'Running': True}})

    def test_empty_mutation_response_retains_existing_call_contract(self):
        with inspect_response(204, b'') as engine:
            self.assertIsNone(engine.call('POST', '/containers/test/start', timeout=1))


if __name__ == '__main__':
    unittest.main()
