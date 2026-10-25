"""Host-only, stdlib image sealing; never starts containers.

build(root, docker) and verified_image(root, docker) return a full image ID.
Pass gatectl's docker(*args, timeout=...) -> bytes callback. Validation failures
raise ValueError; callback failures propagate. Callers must start the returned
immutable ID, not the mutable tag. The host tree and Docker daemon are trusted;
this detects drift, not an attacker already able to rewrite this helper.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat


BASE_ALIAS = 'pi-sandbox:hub-base-7bf9caecf2e0'
BASE_IMAGE = 'sha256:7bf9caecf2e0577c126c1232aaadcba836c762a0bd299bf20590a386f8dd86ee'
IMAGE_TAG = 'pi-deploy-gate:20261016-1'
SOURCE_LABEL = 'pi.deploy-gate.source-sha256'
BASE_LABEL = 'pi.deploy-gate.base-image'
SEAL = '.image-seal.json'
SOURCES = ('Dockerfile', 'policy.json', 'terminal-policy.json', 'compose.yaml', 'gatectl', '.dockerignore')
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}')
FINGERPRINT = re.compile(r'[0-9a-f]{64}')


@contextmanager
def _root(root):
    path = Path(os.path.abspath(root))
    try:
        if path.resolve(strict=True) != path:
            raise ValueError('symlinked gate root refused')
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as error:
        raise ValueError('gate root must be a real directory') from error
    try:
        yield path, fd
    finally:
        os.close(fd)


def _read(directory, name, *, seal=False):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory)
    except OSError as error:
        raise ValueError('missing or unsafe gate input: ' + name) from error
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('gate inputs must be regular files')
        if seal and (stat.S_IMODE(info.st_mode) != 0o600 or
                     info.st_uid != os.geteuid() or info.st_nlink != 1):
            raise ValueError('seal must be owned by this user, single-linked, and mode 0600')
        data = stream.read(16385) if seal else stream.read()
        if seal and len(data) > 16384:
            raise ValueError('oversized image seal')
        return data


def _fingerprint(directory):
    digest = hashlib.sha256(b'pi-deploy-gate-source-v1\0')

    def include(name, data):
        encoded = name.encode('utf-8')
        digest.update(len(encoded).to_bytes(8, 'big'))
        digest.update(encoded)
        digest.update(len(data).to_bytes(8, 'big'))
        digest.update(data)

    for name in sorted(SOURCES):
        include(name, _read(directory, name))
    try:
        gate = os.open('gate', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                       dir_fd=directory)
    except OSError as error:
        raise ValueError('gate must be a real directory') from error
    try:
        names = sorted(name for name in os.listdir(gate) if name.endswith('.py'))
        if not names:
            raise ValueError('missing gate Python sources')
        for name in names:
            include('gate/' + name, _read(gate, name))
    finally:
        os.close(gate)
    return digest.hexdigest()


def _inspect(docker, reference):
    try:
        records = json.loads(docker('image', 'inspect', reference, timeout=30))
        if not isinstance(records, list) or len(records) != 1:
            raise ValueError('expected exactly one image')
        image = records[0]
        if not isinstance(image, dict) or not isinstance(image.get('Id'), str):
            raise ValueError('missing full image ID')
        if not IMAGE_ID.fullmatch(image['Id']):
            raise ValueError('invalid image ID')
        rootfs = image.get('RootFS')
        if not isinstance(rootfs, dict) or rootfs.get('Type') != 'layers':
            raise ValueError('missing rootfs layers')
        layers = rootfs.get('Layers')
        if not isinstance(layers, list) or not layers or any(
                not isinstance(layer, str) or not IMAGE_ID.fullmatch(layer) for layer in layers):
            raise ValueError('invalid rootfs layers')
        return image
    except (UnicodeError, json.JSONDecodeError, TypeError) as error:
        raise ValueError('malformed Docker image inspection') from error


def _trusted_base(docker):
    alias = _inspect(docker, BASE_ALIAS)
    if alias['Id'] != BASE_IMAGE:
        raise ValueError('trusted base alias does not match pinned image ID')
    base = _inspect(docker, BASE_IMAGE)
    if base['Id'] != BASE_IMAGE or alias['RootFS'] != base['RootFS']:
        raise ValueError('trusted base inspection mismatch')
    return base['RootFS']['Layers']


def _verify_docker(docker, image_id, fingerprint):
    base_layers = _trusted_base(docker)
    tagged = _inspect(docker, IMAGE_TAG)
    if tagged['Id'] != image_id:
        raise ValueError('gate image tag changed; rebuild before starting')
    image = _inspect(docker, image_id)
    if image['Id'] != image_id:
        raise ValueError('sealed image ID mismatch')
    for candidate in (tagged, image):
        config = candidate.get('Config')
        labels = config.get('Labels') if isinstance(config, dict) else None
        if not isinstance(labels, dict) or labels.get(SOURCE_LABEL) != fingerprint or \
                labels.get(BASE_LABEL) != BASE_IMAGE:
            raise ValueError('gate source/base image labels do not match')
        if candidate['RootFS']['Layers'][:len(base_layers)] != base_layers:
            raise ValueError('gate rootfs does not descend from the trusted base')


def _existing_seal(directory):
    try:
        os.stat(SEAL, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return
    _read(directory, SEAL, seal=True)


def _write_seal(directory, record):
    temporary = '.image-seal-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write((json.dumps(record, sort_keys=True) + '\n').encode('utf-8'))
            stream.flush()
            os.fsync(stream.fileno())
        _existing_seal(directory)
        os.replace(temporary, SEAL, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def build(root, docker):
    """Build/seal the trusted gate, returning its full ID (180s build timeout)."""
    with _root(root) as (path, directory):
        _existing_seal(directory)
        fingerprint = _fingerprint(directory)
        _trusted_base(docker)
        output = docker('build', '--quiet', '--pull=false', '--network=none',
                        '--label', SOURCE_LABEL + '=' + fingerprint,
                        '--label', BASE_LABEL + '=' + BASE_IMAGE,
                        '--tag', IMAGE_TAG, '--file', str(path / 'Dockerfile'),
                        str(path), timeout=180)
        try:
            image_id = output.decode('ascii').strip()
        except (AttributeError, UnicodeError) as error:
            raise ValueError('build did not return a full image ID') from error
        if not IMAGE_ID.fullmatch(image_id):
            raise ValueError('build did not return a full image ID')
        _verify_docker(docker, image_id, fingerprint)
        if _fingerprint(directory) != fingerprint:
            raise ValueError('gate source changed during build; rebuild required')
        _write_seal(directory, {'imageId': image_id, 'sourceFingerprint': fingerprint,
                                'baseImage': BASE_IMAGE, 'imageTag': IMAGE_TAG})
        return image_id


def verified_image(root, docker):
    """Read-only seal verification; return an immutable ID or fail closed."""
    with _root(root) as (_, directory):
        try:
            seal = json.loads(_read(directory, SEAL, seal=True))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ValueError('malformed gate image seal') from error
        if not isinstance(seal, dict):
            raise ValueError('malformed gate image seal')
        image_id = seal.get('imageId')
        fingerprint = seal.get('sourceFingerprint')
        if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id) or \
                not isinstance(fingerprint, str) or not FINGERPRINT.fullmatch(fingerprint) or \
                seal.get('baseImage') != BASE_IMAGE or seal.get('imageTag') != IMAGE_TAG:
            raise ValueError('invalid gate image seal fields')
        if _fingerprint(directory) != fingerprint:
            raise ValueError('gate source changed; rebuild before starting')
        _verify_docker(docker, image_id, fingerprint)
        if _fingerprint(directory) != fingerprint:
            raise ValueError('gate source changed during verification')
        return image_id
