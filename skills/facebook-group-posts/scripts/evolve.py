"""Local, review-led evolution of this skill. No browser or network operations."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

NAME = 'facebook-group-posts'
CORE_TESTS = ('tests/test-collector.mjs', 'tests/test-batches.mjs', 'tests/test-audit-export.py')
EVOLVE_TEST = 'tests/test-evolve.py'
PORTABLE_CORE = ('scripts/portable.py', 'tests/test-portable.py')
DEFAULT_NODE = os.environ.get('FB_GROUP_POSTS_NODE', 'node')
DEFAULT_PYTHON = os.environ.get('FB_GROUP_POSTS_PYTHON', sys.executable)
LOCK = '.evolution-promote.lock'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def read(file):
    return json.loads(Path(file).read_text(encoding='utf-8'))


def write(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def fingerprint(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def allowed(relative):
    parts = Path(relative).parts
    if relative in ('SKILL.md', 'pack-manifest.json', 'agents/openai.yaml'):
        return True
    if len(parts) != 2:
        return False
    folder, name = parts
    return ((folder == 'scripts' and Path(name).suffix in ('.py', '.mjs'))
            or (folder == 'tests' and name.startswith('test-') and Path(name).suffix in ('.py', '.mjs'))
            or (folder == 'references' and name.endswith('.md'))
            or (folder == 'assets' and name.endswith('-template.json')))


def inventory(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'SKILL_DIRECTORY_REQUIRED')
    result = {}
    for item in root.rglob('*'):
        require(not item.is_symlink() and not (getattr(item.lstat(), 'st_file_attributes', 0) & 0x400),
                'REPARSE_POINT_NOT_ALLOWED')
        relative = item.relative_to(root).as_posix()
        if '__pycache__' in item.parts or relative == LOCK:
            continue
        if item.is_file():
            require(allowed(relative), 'FILE_OUTSIDE_TECHNICAL_ALLOWLIST: ' + relative)
            result[relative] = digest(item)
    require(all(test in result for test in CORE_TESTS), 'ORIGINAL_CORE_TESTS_REQUIRED')
    require('SKILL.md' in result and 'pack-manifest.json' in result,
            'SKILL_CORE_FILES_REQUIRED')
    require(read(root / 'pack-manifest.json').get('name') == NAME, 'WRONG_SKILL_NAME')
    require(re.search(r'(?m)^name:\s*facebook-group-posts\s*$',
                      (root / 'SKILL.md').read_text(encoding='utf-8')), 'WRONG_SKILL_FRONTMATTER')
    return dict(sorted(result.items()))


def semver(value):
    require(isinstance(value, str) and re.fullmatch(r'\d+\.\d+\.\d+', value), 'SEMANTIC_VERSION_REQUIRED')
    return tuple(map(int, value.split('.')))


def manifest_matches(root, files):
    declared = read(Path(root) / 'pack-manifest.json').get('files', [])
    expected = {name: sha for name, sha in files.items() if name != 'pack-manifest.json'}
    actual = {item.get('path'): item.get('sha256') for item in declared}
    require(len(actual) == len(declared) and actual == expected, 'MANIFEST_HASH_MISMATCH')


def refresh_manifest(root, base_version):
    root = Path(root)
    files = inventory(root)
    manifest = read(root / 'pack-manifest.json')
    if semver(manifest.get('version')) <= semver(base_version):
        major, minor, patch = semver(base_version)
        manifest['version'] = f'{major}.{minor}.{patch + 1}'
    manifest['files'] = [dict(path=name, bytes=(root / name).stat().st_size, sha256=sha)
                         for name, sha in files.items() if name != 'pack-manifest.json']
    manifest['built_date'] = datetime.now(timezone.utc).date().isoformat()
    manifest['updated_at'] = now()
    write(root / 'pack-manifest.json', manifest)
    return inventory(root)


def workspace_root(workspace, source=None):
    workspace = Path(workspace).resolve()
    helper_skill = Path(__file__).resolve().parents[1]
    require(not workspace.is_relative_to(helper_skill), 'RECEIPTS_MUST_STAY_OUTSIDE_SKILL')
    for ancestor in (workspace, *workspace.parents):
        manifest = ancestor / 'pack-manifest.json'
        if manifest.is_file():
            require(read(manifest).get('name') != NAME, 'RECEIPTS_MUST_STAY_OUTSIDE_SKILL')
    if source is not None:
        source = Path(source).resolve()
        require(not workspace.is_relative_to(source), 'RECEIPTS_MUST_STAY_OUTSIDE_SKILL')
    result = workspace / '.skill-evolution'
    result.mkdir(parents=True, exist_ok=True)
    return result


def review(workspace, outcome, decision, reason, technical_only_reviewed=False, evidence=None):
    require(outcome in ('complete', 'partial', 'failed', 'cancelled', 'paused'), 'TERMINAL_OUTCOME_REQUIRED')
    require(decision in ('no_change', 'candidate'), 'INVALID_REVIEW_DECISION')
    require(bool(reason.strip()), 'REVIEW_REASON_REQUIRED')
    require(decision == 'no_change' or technical_only_reviewed, 'AGENT_TECHNICAL_REVIEW_REQUIRED')
    base = workspace_root(workspace)
    evidence_files = []
    for value in evidence or []:
        file = Path(value).resolve()
        require(file.is_file() and file.is_relative_to(Path(workspace).resolve()), 'EVIDENCE_MUST_BE_A_TASK_LOCAL_FILE')
        evidence_files.append(dict(path=str(file), sha256=digest(file), bytes=file.stat().st_size))
    require(decision == 'no_change' or evidence_files, 'CANDIDATE_REQUIRES_ACTUAL_EVIDENCE')
    receipt = dict(id=uuid.uuid4().hex, created_at=now(), outcome=outcome, decision=decision,
                   reason=reason, technical_only_reviewed=bool(technical_only_reviewed),
                   evidence=evidence_files,
                   limitation='Agent assessment; the helper does not infer generality or safety from text.')
    file = base / 'reviews' / (receipt['id'] + '.json')
    write(file, receipt)
    write(base / 'current-review.json', dict(review_file=str(file)))
    marker_file = Path(workspace).resolve() / 'evolution-review-status.json'
    marker = read(marker_file) if marker_file.is_file() else {}
    marker.update(schema_version=1, status='completed', review_required=False,
                  completed_at=now(), declared_outcome=outcome, decision=decision,
                  review_file=str(file), review_sha256=digest(file))
    write(marker_file, marker)
    return dict(review_file=str(file), decision=decision, changed_skill=False)


def copy_files(source, destination, files):
    for name in files:
        target = Path(destination) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(Path(source) / name, target)


def stage(workspace, skill_root):
    raw_source = Path(skill_root).absolute()
    require(not raw_source.is_symlink() and not (getattr(raw_source.lstat(), 'st_file_attributes', 0) & 0x400),
            'REPARSE_POINT_NOT_ALLOWED')
    source = raw_source.resolve()
    files = inventory(source)
    manifest_matches(source, files)
    base = workspace_root(workspace, source)
    review_file = Path(read(base / 'current-review.json')['review_file'])
    require(review_file.resolve().is_relative_to(base / 'reviews'), 'REVIEW_OUTSIDE_WORKSPACE')
    assessment = read(review_file)
    require(assessment.get('decision') == 'candidate' and assessment.get('technical_only_reviewed') is True,
            'AGENT_TECHNICAL_REVIEW_REQUIRED')
    folder = base / 'stages' / uuid.uuid4().hex
    candidate = folder / 'candidate'
    original = folder / 'original'
    copy_files(source, original, files)
    copy_files(source, candidate, files)
    transaction = dict(id=folder.name, source=str(source), source_files=files,
                       source_manifest_hash=files['pack-manifest.json'], source_fingerprint=fingerprint(files),
                       source_version=read(source / 'pack-manifest.json')['version'],
                       review_file=str(review_file), review_hash=digest(review_file),
                       phase='staged', created_at=now())
    write(folder / 'transaction.json', transaction)
    return dict(candidate=str(candidate), transaction=str(folder / 'transaction.json'), phase='staged')


def transaction_for(workspace, candidate):
    candidate = Path(candidate).resolve()
    base = workspace_root(workspace)
    require(candidate.name == 'candidate' and candidate.parent.parent == base / 'stages',
            'CANDIDATE_OUTSIDE_TASK_WORKSPACE')
    transaction = read(candidate.parent / 'transaction.json')
    source = Path(transaction['source']).resolve()
    workspace_root(workspace, source)
    require(digest(transaction['review_file']) == transaction['review_hash'], 'REVIEW_RECEIPT_CHANGED')
    for item in read(transaction['review_file']).get('evidence', []):
        require(digest(item['path']) == item['sha256'], 'REVIEW_EVIDENCE_CHANGED')
    require(inventory(candidate.parent / 'original') == transaction['source_files'], 'ORIGINAL_SNAPSHOT_CHANGED')
    return candidate, transaction


def executable(value):
    found = shutil.which(value)
    require(found and Path(found).is_file(), 'TEST_RUNTIME_NOT_FOUND: ' + value)
    return str(Path(found).resolve())


def check_commands(tree, python, node, tests, portable_gate=False, forbidden_tokens=None):
    node_tests = [str(tree / name) for name in tests if name.endswith('.mjs')]
    commands = [[node, '--test', *node_tests]] if node_tests else []
    commands += [[python, str(tree / name)] for name in tests if name.endswith('.py')]
    if portable_gate:
        command = [python, '-B', str(tree / 'scripts/portable.py'), 'doctor',
                   '--skill-root', str(tree), '--require', 'package']
        for token in forbidden_tokens or []:
            command.extend(['--forbid-token', token])
        commands.append(command)
    return commands


def test_review_binding(before, after):
    changed = [dict(path=name, before_sha256=before.get(name), after_sha256=after.get(name))
               for name in sorted(set(before) | set(after))
               if name.startswith('tests/') and before.get(name) != after.get(name)]
    technical = lambda files: {name: sha for name, sha in files.items() if name != 'pack-manifest.json'}
    return dict(source_content_fingerprint=fingerprint(technical(before)),
                candidate_content_fingerprint=fingerprint(technical(after)),
                test_diff_fingerprint=fingerprint(changed), changed_tests=changed)


def check_test_review(workspace, review_file, binding):
    if not binding['changed_tests']:
        return None
    require(review_file, 'TEST_DIFF_REVIEW_REQUIRED')
    file = Path(review_file).resolve()
    require(file.is_file() and file.is_relative_to(Path(workspace).resolve()), 'TEST_REVIEW_MUST_BE_TASK_LOCAL')
    value = read(file)
    require(value.get('decision') == 'approved' and value.get('reviewer') and value.get('reason'),
            'INDEPENDENT_TEST_REVIEW_REQUIRED')
    for key, expected in binding.items():
        require(value.get(key) == expected, 'TEST_REVIEW_BINDING_CHANGED: ' + key)
    require(value.get('evidence'), 'TEST_REVIEW_EVIDENCE_REQUIRED')
    for item in value['evidence']:
        evidence = Path(item['path']).resolve()
        require(evidence.is_file() and evidence.is_relative_to(Path(workspace).resolve()), 'TEST_REVIEW_EVIDENCE_OUTSIDE_TASK')
        require(digest(evidence) == item['sha256'], 'TEST_REVIEW_EVIDENCE_CHANGED')
    return dict(path=str(file), sha256=digest(file), binding=binding)


def run_checks(workspace, candidate, transaction, python, node, runner=None, forbidden_tokens=None):
    # runner injection exists only for deterministic unit tests of failures/rollback.
    # The CLI has no runner/command override and always executes subprocess.run.
    python, node = executable(python), executable(node)
    process_cwd = str(Path(workspace).resolve())
    require(os.name != 'nt' or len(process_cwd.encode('utf-16-le')) // 2 < 260,
            'TASK_WORKSPACE_TOO_LONG_FOR_WINDOWS_PROCESS_CWD')
    runner = runner or subprocess.run
    folder = workspace_root(workspace) / 'checks' / uuid.uuid4().hex
    files = inventory(candidate)
    (folder / 'tmp').mkdir(parents=True)
    environment = os.environ.copy()
    for key in ('PYTHONPATH', 'NODE_OPTIONS', 'NODE_PATH'):
        environment.pop(key, None)
    environment.update(TMP=str(folder / 'tmp'), TEMP=str(folder / 'tmp'), TMPDIR=str(folder / 'tmp'),
                       PYTHONDONTWRITEBYTECODE='1', FB_SKILL_EVOLUTION_TEST_WORKSPACE=process_cwd,
                       FB_GROUP_POSTS_PYTHON=python, FB_GROUP_POSTS_NODE=node)
    results = []
    groups = [('baseline', candidate.parent / 'original', transaction['source_files']),
              ('candidate', candidate, files)]
    for label, input_tree, tree_files in groups:
        tree = folder / label[0]
        copy_files(input_tree, tree, tree_files)
        tests = sorted(name for name in tree_files if name.startswith('tests/'))
        for command in check_commands(tree, python, node, tests, label == 'candidate', forbidden_tokens):
            log = folder / f'{len(results) + 1:02d}-{label}.log'
            try:
                # Windows CreateProcess rejects an overly long current directory
                # even when Node can open the same long absolute script path.
                completed = runner(command, cwd=process_cwd, env=environment, shell=False,
                                   capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300)
                log.write_text((completed.stdout or '') + '\n' + (completed.stderr or ''), encoding='utf-8')
                result = dict(group=label, command=command, cwd=process_cwd, exit_code=completed.returncode, log=str(log))
            except (subprocess.TimeoutExpired, OSError) as error:
                detail = dict(error=type(error).__name__, errno=getattr(error, 'errno', None),
                              winerror=getattr(error, 'winerror', None), cwd=process_cwd)
                log.write_text(json.dumps(detail), encoding='utf-8')
                result = dict(group=label, command=command, cwd=process_cwd, exit_code=-1, log=str(log), error=detail)
            results.append(result)
            if 'error' in result or (label == 'candidate' and result['exit_code'] != 0):
                write(folder / 'result.json', dict(passed=False, checks=results))
                raise ValueError('OFFLINE_CHECK_FAILED: ' + str(log))
    require(inventory(candidate) == files, 'CANDIDATE_CHANGED_DURING_CHECKS')
    write(folder / 'result.json', dict(passed=True,
                                      baseline_passed=all(item['exit_code'] == 0 for item in results if item['group'] == 'baseline'),
                                      candidate_passed=True, checks=results))
    return results


def validate(workspace, candidate, python=DEFAULT_PYTHON, node=DEFAULT_NODE, tests_review=None,
             runner=None, forbidden_tokens=None):
    candidate, transaction = transaction_for(workspace, candidate)
    forbidden_tokens = list(forbidden_tokens or [])
    current = inventory(candidate)
    require('scripts/evolve.py' in current and EVOLVE_TEST in current, 'CANDIDATE_EVOLUTION_CORE_REQUIRED')
    require(all(name in current for name in PORTABLE_CORE), 'CANDIDATE_PORTABLE_CORE_REQUIRED')
    changed = [name for name in set(current) | set(transaction['source_files'])
               if name != 'pack-manifest.json' and current.get(name) != transaction['source_files'].get(name)]
    require(changed, 'NO_TECHNICAL_CHANGE_USE_NO_CHANGE')
    files = refresh_manifest(candidate, transaction['source_version'])
    manifest_matches(candidate, files)
    if tests_review is None and (candidate.parent / 'validation.json').exists():
        tests_review = (read(candidate.parent / 'validation.json').get('tests_review') or {}).get('path')
    review_receipt = check_test_review(workspace, tests_review, test_review_binding(transaction['source_files'], files))
    checks = run_checks(workspace, candidate, transaction, python, node, runner, forbidden_tokens)
    receipt = dict(validated_at=now(), passed=True, candidate_fingerprint=fingerprint(files),
                   candidate_manifest_hash=files['pack-manifest.json'], changed_files=sorted(changed),
                   baseline_passed=all(item['exit_code'] == 0 for item in checks if item['group'] == 'baseline'),
                   candidate_passed=True, tests_review=review_receipt,
                   forbidden_tokens=forbidden_tokens,
                   forbidden_token_hashes=[hashlib.sha256(value.casefold().encode('utf-8')).hexdigest()
                                           for value in forbidden_tokens],
                   checks=checks, limitation='Original baseline is reported; candidate tests are required. Neither proves semantics or all old contracts.')
    write(candidate.parent / 'validation.json', receipt)
    return receipt


def atomic_copy(source, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name('.' + target.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with Path(source).open('rb') as src, temporary.open('xb') as dst:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def restore(source, backup, before, after):
    # Reject unrelated concurrent changes rather than overwrite them during rollback.
    current = inventory(source)
    for name in set(current) | set(before) | set(after):
        require(current.get(name) in (before.get(name), after.get(name)), 'SOURCE_DRIFT_DURING_ROLLBACK')
    for name in before:
        atomic_copy(Path(backup) / name, Path(source) / name)
    for name in set(after) - set(before):
        (Path(source) / name).unlink(missing_ok=True)
    require(inventory(source) == before, 'ROLLBACK_HASH_MISMATCH')


def promote(workspace, candidate, python=DEFAULT_PYTHON, node=DEFAULT_NODE, tests_review=None,
            runner=None, replace=None, forbidden_tokens=None):
    candidate, transaction = transaction_for(workspace, candidate)
    source = Path(transaction['source'])
    require(transaction['phase'] in ('staged', 'validation_failed'), 'TRANSACTION_ALREADY_FINISHED')
    require(inventory(source) == transaction['source_files'], 'SOURCE_DRIFT_RESTAGE_REQUIRED')
    # A saved "PASS" is not authority: promotion executes the fixed checks again.
    saved_validation = read(candidate.parent / 'validation.json') if (candidate.parent / 'validation.json').exists() else {}
    if forbidden_tokens is None:
        forbidden_tokens = saved_validation.get('forbidden_tokens', [])
    validation = validate(workspace, candidate, python, node, tests_review=tests_review,
                          runner=runner, forbidden_tokens=forbidden_tokens)
    after = inventory(candidate)
    require(validation['candidate_fingerprint'] == fingerprint(after), 'VALIDATED_CANDIDATE_CHANGED')
    require(semver(read(candidate / 'pack-manifest.json')['version']) > semver(transaction['source_version']),
            'VERSION_MUST_INCREASE')
    frozen = candidate.parent / ('validated-copy-' + uuid.uuid4().hex)
    copy_files(candidate, frozen, after)
    require(inventory(frozen) == after, 'CANDIDATE_CHANGED_WHILE_FREEZING')
    lock_path = source / LOCK
    with lock_path.open('x', encoding='utf-8') as lock:
        lock.write(str(os.getpid()))
    transaction_file = candidate.parent / 'transaction.json'
    backup = candidate.parent / 'backup'
    try:
        before = inventory(source)
        require(before == transaction['source_files'], 'SOURCE_DRIFT_RESTAGE_REQUIRED')
        copy_files(source, backup, before)
        transaction.update(phase='promoting', backup=str(backup), candidate_files=after,
                           validation_file=str(candidate.parent / 'validation.json'), promotion_started_at=now())
        write(transaction_file, transaction)
        copier = replace or atomic_copy
        try:
            for name in after:
                if before.get(name) != after[name]:
                    copier(frozen / name, source / name)
            for name in set(before) - set(after):
                (source / name).unlink()
            require(inventory(source) == after, 'INSTALLED_HASH_MISMATCH')
        except Exception:
            try:
                restore(source, backup, before, after)
                transaction['phase'] = 'rolled_back'
            except Exception:
                transaction['phase'] = 'rollback_requires_review'
                write(transaction_file, transaction)
                raise
            write(transaction_file, transaction)
            raise
        transaction.update(phase='promoted', promoted_at=now(), installed_version=read(source / 'pack-manifest.json')['version'])
        write(transaction_file, transaction)
    finally:
        lock_path.unlink(missing_ok=True)
    return dict(phase='promoted', source=str(source), version=transaction['installed_version'],
                backup=str(backup), transaction=str(transaction_file), browser_task_restarted=False)


def rollback(workspace, candidate):
    candidate, transaction = transaction_for(workspace, candidate)
    require(transaction['phase'] in ('promoted', 'promoting', 'rollback_requires_review'), 'NO_PROMOTION_TO_ROLL_BACK')
    source = Path(transaction['source'])
    lock_path = source / LOCK
    with lock_path.open('x', encoding='utf-8') as lock:
        lock.write(str(os.getpid()))
    try:
        require(inventory(transaction['backup']) == transaction['source_files'], 'BACKUP_HASH_MISMATCH')
        restore(source, transaction['backup'], transaction['source_files'], transaction['candidate_files'])
        transaction.update(phase='rolled_back', rolled_back_at=now())
        write(candidate.parent / 'transaction.json', transaction)
    finally:
        lock_path.unlink(missing_ok=True)
    return dict(phase='rolled_back', browser_task_restarted=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('review', 'stage', 'validate', 'promote', 'rollback', 'status'):
        command = sub.add_parser(action)
        command.add_argument('--workspace', required=True)
        if action == 'review':
            command.add_argument('--outcome', required=True)
            command.add_argument('--decision', choices=('no_change', 'candidate'), required=True)
            command.add_argument('--reason', required=True)
            command.add_argument('--technical-only-reviewed', action='store_true')
            command.add_argument('--evidence', action='append', default=[])
        elif action == 'stage':
            command.add_argument('--skill-root', required=True)
        else:
            command.add_argument('--candidate', required=True)
        if action in ('validate', 'promote'):
            command.add_argument('--python', default=DEFAULT_PYTHON)
            command.add_argument('--node', default=DEFAULT_NODE)
            command.add_argument('--tests-review')
            command.add_argument('--forbid-token', action='append', default=None, dest='forbidden_tokens')
    args = vars(parser.parse_args())
    action = args.pop('action')
    if action == 'status':
        candidate, value = transaction_for(**args)
        validation = read(candidate.parent / 'validation.json') if (candidate.parent / 'validation.json').exists() else None
        value = dict(value, validation=validation,
                     test_review_binding=test_review_binding(value['source_files'], inventory(candidate)),
                     validation_matches_current=bool(validation and validation.get('candidate_fingerprint') == fingerprint(inventory(candidate))))
    else:
        value = globals()[action](**args)
    print(json.dumps(value, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(error=type(error).__name__, message=str(error)), ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
