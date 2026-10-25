"""Bounded public source identity checks; no request-provided URL or credential."""
import json
import re
import urllib.request

from .artifacts import NoRedirect
from .store import check_sha


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate source response key')
        value[key] = item
    return value


def parse_head(raw, branch):
    if len(raw) > 65536:
        raise ValueError('source response exceeds limit')
    try:
        value = json.loads(raw, object_pairs_hook=_unique)
        if (not isinstance(value, dict) or value.get('ref') != 'refs/heads/' + branch or
                not isinstance(value.get('object'), dict) or value['object'].get('type') != 'commit'):
            raise ValueError('source ref mismatch')
        return check_sha(value['object']['sha'])
    except (KeyError, TypeError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError('invalid source response') from error


def fetch_head(source, opener=None):
    repository, branch = source.get('repository'), source.get('auto_branch')
    if repository != 'swordfate3/pi-web-ui' or not isinstance(branch, str) or not re.fullmatch(
            r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', branch):
        raise ValueError('unapproved source')
    if opener is None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    url = 'https://api.github.com/repos/' + repository + '/git/ref/heads/' + branch
    request = urllib.request.Request(url, headers={
        'Accept': 'application/vnd.github+json', 'User-Agent': 'pi-deploy-gate',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    with opener.open(request, timeout=10) as response:
        return parse_head(response.read(65537), branch)
