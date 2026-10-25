"""Test harness observations must match the real runtime status contract."""
import unittest

from real_version_acceptance import conversation_history_matches, generation_deferral_observed


class ConversationHistoryObservationTests(unittest.TestCase):
    @staticmethod
    def entries(*roles):
        return [{'type': 'message', 'message': {'role': role}} for role in roles]

    def test_sdk_system_entry_is_not_an_extra_conversation_turn(self):
        self.assertTrue(conversation_history_matches(
            self.entries('user', 'assistant', 'system', 'user', 'assistant'), generated=True))

    def test_saved_conversation_without_generation_stays_unchanged(self):
        self.assertTrue(conversation_history_matches(self.entries('user', 'assistant'), generated=False))
        self.assertFalse(conversation_history_matches(
            self.entries('user', 'assistant', 'user', 'assistant'), generated=False))

    def test_replayed_missing_reordered_or_tool_turns_are_rejected(self):
        for roles in (('user', 'assistant', 'user', 'assistant', 'user', 'assistant'),
                      ('user', 'assistant', 'system'),
                      ('user', 'assistant', 'assistant', 'user'),
                      ('user', 'assistant', 'toolResult', 'user', 'assistant'),
                      ('user', 'assistant', None, 'user', 'assistant')):
            with self.subTest(roles=roles):
                self.assertFalse(conversation_history_matches(self.entries(*roles), generated=True))


class GenerationDeferralObservationTests(unittest.TestCase):
    def setUp(self):
        self.idle = {'version': '1.4.0', 'idle': True, 'runtime_id': 'new-idle'}
        self.original = {'version': '1.3.0', 'runtime_id': 'original-generating'}
        self.generating = {**self.original, 'idle': False, 'busy': False}
        self.calls = [{'generation': True}]

    def test_live_generation_is_nonidle_without_input_guard_taint(self):
        self.assertTrue(generation_deferral_observed(
            self.idle, self.generating, self.original, self.calls))

    def test_tainted_or_idle_status_does_not_substitute_for_live_generation(self):
        for changed in ({'idle': True, 'busy': True}, {'version': '1.4.0'},
                        {'runtime_id': 'replaced-generating'}):
            with self.subTest(changed=changed):
                self.assertFalse(generation_deferral_observed(
                    self.idle, {**self.generating, **changed}, self.original, self.calls))
        for calls in ([], [{'generation': False}], self.calls * 2):
            with self.subTest(calls=calls):
                self.assertFalse(generation_deferral_observed(
                    self.idle, self.generating, self.original, calls))

    def test_idle_peer_must_have_adopted_selected_version(self):
        self.assertFalse(generation_deferral_observed(
            {**self.idle, 'version': '1.3.0'}, self.generating, self.original, self.calls))


if __name__ == '__main__':
    unittest.main()
