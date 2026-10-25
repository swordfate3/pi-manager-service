#!/usr/bin/env python3
"""Pi request client: submit versions, list services and inspect requests."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import stat
import urllib.error
import urllib.request


def read_token(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        details = os.fstat(descriptor)
        if (not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or
                stat.S_IMODE(details.st_mode) & 0o077):
            raise ValueError('unsafe credential file')
        with os.fdopen(descriptor, 'rb') as stream:
            descriptor = None
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise ValueError('credential file exceeds limit')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'token'}:
            raise ValueError('invalid credential object')
        token = value['token']
        if not re.fullmatch('[0-9a-f]{64}', token):
            raise ValueError('invalid request credential')
        return token
    finally:
        if descriptor is not None:
            os.close(descriptor)


def main():
    formatting = {'formatter_class': argparse.RawDescriptionHelpFormatter}
    parser = argparse.ArgumentParser(
        prog='pi-gate', description='Pi 部署申请客户端：查询服务、提交更新、申请接入。',
        epilog='''快速上手（在 Pi 容器终端执行）：
  pi-gate services                       查看已登记服务及审批模式
  pi-gate request <完整40位commit>        申请更新 Hub，默认服务 pi-web-hub
  pi-gate status                         查看申请 ID、状态及进度
  pi-gate runtime-update 1.2.3           申请安装精确稳定版 Pi runtime
  pi-gate runtime-status                 查看 runtime 策略、任务及活跃更新
  pi-gate request --help                 查看版本格式与其他服务的示例
  pi-gate onboard --help                 查看接入意向的 JSON 格式

审批模式：
  manual    等待宿主机管理员逐次批准
  auto      明确提交申请后，符合已登记规则才自动验证部署
  disabled  暂停接收更新；仍保留恢复能力

重要说明：
  auto 不监听推送，不自动执行旧待批；Hub 自动申请须匹配固定仓库 main 当前提交。
  此客户端仅能申请和查询，不能审批、修改策略或直接管理 Docker。
  普通镜像服务须先由管理员登记，只接受指定仓库的完整 sha256 摘要，不接受 latest。
  未安装凭据或门控未运行时仍可查看 --help；实际请求需管理员安装申请客户端。
  所有 <...> 都是占位符，使用时替换为真实值，不保留尖括号。''', **formatting)
    commands = parser.add_subparsers(dest='command', required=True, title='子命令', metavar='命令')
    request = commands.add_parser(
        'request', help='提交 Hub 或已登记镜像服务的更新申请',
        description='提交指定版本的更新申请；是否自动执行由管理员保存的服务策略决定。',
        epilog='''示例：
  pi-gate request <完整40位commit>
  pi-gate request 'ghcr.io/example/api@sha256:<完整64位摘要>' --service example-api

Hub：先提交并推送已构建的 dist/hub 产物；自动部署仅允许固定仓库 main 当前完整提交。
其他镜像：先用 pi-gate services 确认服务已登记，摘要须属于该服务登记的仓库。
提交成功不等于部署成功，请用 pi-gate status 查看 queued / pending / deployed 等状态。
来源不能确认或 Hub 不是当前 main 时可能转为待人工审批，不会放宽自动规则。
<...> 为占位符，执行前替换为真实值；无需也不要在命令中填写 token。''', **formatting)
    request.add_argument('version', metavar='VERSION', help='Hub 的完整40位commit，或 repository@sha256:完整64位摘要')
    request.add_argument('--service', default='pi-web-hub', metavar='SERVICE',
                         help='已登记的服务 ID（默认：pi-web-hub）')
    commands.add_parser(
        'status', help='查看最近100条申请的 ID、状态和部署进度',
        description='查询最近100条申请，不提交更新，也不改变审批状态。',
        epilog='''示例：pi-gate status
pending=待人工审批；queued=等待自动执行；deploying=部署中；deployed=完成。
stale=授权条件已变化，核实后重新申请；recovery_required=需要管理员检查。
本命令不接受申请 ID 参数；将需要核查的申请 ID 交给管理员。''', **formatting)
    commands.add_parser(
        'services', help='查看已登记服务、允许来源、模式与失败暂停状态',
        description='只读查看可申请更新的服务。未登记的容器不会被门控自动接管。',
        epilog='''示例：pi-gate services
mode 为 manual / auto / disabled；paused=true 时请联系管理员检查后恢复。
列表不包含运行模板或凭据。''', **formatting)
    runtime_update = commands.add_parser(
        'runtime-update', help='申请全局更新共享Pi runtime的精确稳定版本',
        description='提交精确稳定版本 X.Y.Z；由独立runtime策略决定等待批准或进入更新。',
        epilog='''示例：
  pi-gate runtime-update 1.2.3
  pi-gate runtime-update 1.2.3 --idempotency-key <32位小写十六进制值>

只接受没有前导零的精确稳定semver X.Y.Z，不接受latest、范围、预发布或构建元数据。
未指定幂等键时客户端生成随机32位小写十六进制值；重复提交时可复用原键。
申请使用现有request token，不授予策略、批准或其他管理员能力。''', **formatting)
    runtime_update.add_argument('version', metavar='VERSION', help='精确稳定版本 X.Y.Z，例如 1.2.3')
    runtime_update.add_argument('--idempotency-key', metavar='HEX32',
                                help='可选的32位小写十六进制幂等键')
    runtime_status = commands.add_parser(
        'runtime-status', help='查看runtime策略、任务列表、活跃任务或指定任务',
        description='不填ID时返回策略、最近任务和活跃任务；填写ID时返回单个持久化任务。',
        epilog='''示例：
  pi-gate runtime-status
  pi-gate runtime-status <完整32位任务ID>
状态包含安装与会话刷新阶段；忙会话会等待空闲，不会自动重启容器。''', **formatting)
    runtime_status.add_argument('id', nargs='?', metavar='ID', help='可选的完整32位任务ID')
    onboard = commands.add_parser(
        'onboard', help='提交新服务接入意向，等待管理员审核登记',
        description='仅提交接入意向，不会创建容器、登记执行模板或授予自动更新权限。',
        epilog='''示例：pi-gate onboard /workspace/service-intent.json

JSON 文件只接受下面四个字段：
  {
    "service": "example-api",
    "target": "example-api",
    "repository": "ghcr.io/example/api",
    "description": "申请接入该 API 的镜像更新"
  }

使用不超过 4096 字节的普通 JSON 文件，不使用软链接。
不要填写 token、密码、Docker 参数或启动脚本。接入后新服务默认人工审批。''', **formatting)
    onboard.add_argument('file', metavar='FILE', help='接入意向 JSON 文件路径，不是运行模板')
    args = parser.parse_args()
    file = Path(__file__).resolve().with_name('client.json')
    try:
        token = read_token(file)
    except (OSError, ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        parser.error('client.json must be a bounded private regular file owned by the current user')
    value, endpoint = None, 'requests'
    if args.command == 'request':
        if not re.fullmatch('[a-z0-9][a-z0-9_.-]{0,63}', args.service):
            parser.error('invalid service identifier')
        if re.fullmatch('[0-9a-f]{40}', args.version):
            value = {'service': args.service, 'commit': args.version}
        elif re.fullmatch(r'[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}', args.version):
            value = {'service': args.service, 'image': args.version}
        else:
            parser.error('VERSION must be a full Hub commit or repository@sha256:digest')
    elif args.command == 'runtime-update':
        if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', args.version):
            parser.error('VERSION must be exact stable semver X.Y.Z without leading zeros')
        key = args.idempotency_key or secrets.token_hex(16)
        if not re.fullmatch('[0-9a-f]{32}', key):
            parser.error('idempotency key must be exactly 32 lowercase hexadecimal characters')
        value = {'version': args.version, 'idempotency_key': key}
        endpoint = 'runtime-updates'
    elif args.command == 'runtime-status':
        if args.id and not re.fullmatch('[0-9a-f]{32}', args.id):
            parser.error('runtime job ID must be exactly 32 lowercase hexadecimal characters')
        endpoint = 'runtime-updates' + ('/' + args.id if args.id else '')
    elif args.command == 'services':
        endpoint = 'services'
    elif args.command == 'onboard':
        try:
            descriptor = os.open(args.file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, 'rb') as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError('not regular')
                raw = stream.read(4097)
            if len(raw) > 4096:
                raise ValueError('oversize')
            value = json.loads(raw)
            if not isinstance(value, dict) or set(value) != {'service', 'target', 'repository', 'description'}:
                raise ValueError('invalid proposal')
        except (OSError, ValueError):
            parser.error('onboarding input must be a bounded regular non-symlink JSON proposal')
        endpoint = 'intents'
    data = json.dumps(value).encode() if value is not None else None
    req = urllib.request.Request('http://127.0.0.1:16182/v1/' + endpoint, data=data,
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=10) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        parser.exit(1, 'Gate rejected request (HTTP %d); no approval capability is available here.\n' % error.code)
    except OSError:
        parser.exit(1, 'Gate unavailable; ask the host administrator to check it.\n')
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
