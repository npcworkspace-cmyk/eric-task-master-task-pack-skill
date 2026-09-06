import importlib.util
import json
import os
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'portable.py'
SPEC = importlib.util.spec_from_file_location('fb_portable', SCRIPT)
portable = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(portable)


class Fixture:
    def __init__(self, base):
        self.root = Path(base) / portable.NAME
        self.root.mkdir()
        for name in sorted(portable.REQUIRED):
            target = self.root / Path(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f'synthetic portable fixture: {name}\n', encoding='utf-8')
        self.refresh('1.0.0')

    def refresh(self, version):
        files = portable.inventory(self.root)
        manifest = {
            'name': portable.NAME,
            'display_name': 'Synthetic Fixture',
            'version': version,
            'portable_schema_version': 1,
            'includes_real_posts': False,
            'includes_credentials': False,
            'includes_task_configuration': False,
            'files': [
                {'path': name, 'bytes': value['bytes'], 'sha256': value['sha256']}
                for name, value in files.items() if name != portable.MANIFEST
            ],
        }
        (self.root / portable.MANIFEST).write_text(json.dumps(manifest, indent=2), encoding='utf-8')


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fb-portable-tests-')
        self.base = Path(self.temp.name)
        self.fixture = Fixture(self.base)

    def tearDown(self):
        self.temp.cleanup()

    def test_current_candidate_tree_passes_its_own_release_gate(self):
        checked = portable.validate_tree(SCRIPT.parents[1])
        self.assertEqual(checked['manifest']['name'], portable.NAME)
        self.assertFalse(checked['manifest']['includes_task_configuration'])

    def test_open_source_release_metadata_is_allowed_at_skill_root(self):
        for name in portable.RELEASE_ROOT_FILES:
            (self.fixture.root / name).write_text('synthetic release metadata\n', encoding='utf-8')
        self.fixture.refresh('1.0.1')
        checked = portable.validate_tree(self.fixture.root)
        self.assertTrue(portable.RELEASE_ROOT_FILES.issubset(checked['files']))

    def test_tree_and_deterministic_archive_round_trip(self):
        checked = portable.validate_tree(self.fixture.root)
        self.assertEqual(checked['manifest']['version'], '1.0.0')
        first, second = self.base / 'first.zip', self.base / 'second.zip'
        one = portable.package_skill(self.fixture.root, first)
        two = portable.package_skill(self.fixture.root, second)
        self.assertTrue(one['verified'])
        self.assertEqual(one['members'], len(checked['files']))
        self.assertEqual(one['archive_sha256'], two['archive_sha256'])
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(portable.verify_archive(first)['version'], '1.0.0')
        with self.assertRaisesRegex(ValueError, 'OUTPUT_ALREADY_EXISTS'):
            portable.package_skill(self.fixture.root, first)

    def test_unmanifested_file_and_manifest_drift_are_rejected(self):
        extra = self.fixture.root / 'task-output.json'
        extra.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'UNDECLARED_OR_UNSAFE_SKILL_FILE'):
            portable.validate_tree(self.fixture.root)
        extra.unlink()
        (self.fixture.root / 'SKILL.md').write_text('changed', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'MANIFEST_CONTENT_MISMATCH'):
            portable.validate_tree(self.fixture.root)

    def test_cross_platform_filename_collisions_and_reserved_names_are_rejected(self):
        for name in ('scripts/foo\\bar.py', 'scripts/a?.py', 'scripts/a*.py', 'scripts/a|b.py', 'scripts/a<b.py'):
            with self.assertRaisesRegex(ValueError, 'NON_PORTABLE_SKILL_PATH'):
                portable.validate_portable_names([name])
        with self.assertRaisesRegex(ValueError, 'CASE_OR_UNICODE_PATH_COLLISION'):
            portable.validate_portable_names(['scripts/Case.py', 'scripts/case.py'])
        if os.name != 'nt':
            upper = self.fixture.root / 'scripts' / 'Case.py'
            lower = self.fixture.root / 'scripts' / 'case.py'
            upper.write_text('upper', encoding='utf-8')
            lower.write_text('lower', encoding='utf-8')
            names = {entry.name for entry in upper.parent.iterdir()}
            if {'Case.py', 'case.py'}.issubset(names):
                with self.assertRaisesRegex(ValueError, 'CASE_OR_UNICODE_PATH_COLLISION'):
                    portable.inventory(self.fixture.root)
            for target in {upper.resolve(), lower.resolve()}:
                target.unlink(missing_ok=True)
        reserved = self.fixture.root / 'scripts' / 'con.py'
        reserved.write_text('reserved', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'WINDOWS_RESERVED_SKILL_PATH'):
            portable.inventory(self.fixture.root)

    def test_private_paths_concrete_groups_and_caller_tokens_are_rejected(self):
        document = self.fixture.root / 'references' / 'evolution.md'
        private_home = 'C:' + chr(92) + 'Use' + 'rs' + chr(92) + 'private-device' + chr(92) + 'artifact.json'
        document.write_text(private_home, encoding='utf-8')
        self.fixture.refresh('1.0.1')
        with self.assertRaisesRegex(ValueError, 'DEVICE_SPECIFIC_HOME_PATH_FOUND'):
            portable.validate_tree(self.fixture.root)
        escaped_home = '{"workspace":"D:' + chr(92) * 2 + 'Work' + chr(92) * 2 + 'task"}'
        document.write_text(escaped_home, encoding='utf-8')
        self.fixture.refresh('1.0.2')
        with self.assertRaisesRegex(ValueError, 'DEVICE_SPECIFIC_HOME_PATH_FOUND'):
            portable.validate_tree(self.fixture.root)
        unicode_drive = '{"workspace":"D:' + chr(92) * 2 + '项目' + chr(92) * 2 + 'task"}'
        document.write_text(unicode_drive, encoding='utf-8')
        self.fixture.refresh('1.0.2')
        with self.assertRaisesRegex(ValueError, 'DEVICE_SPECIFIC_HOME_PATH_FOUND'):
            portable.validate_tree(self.fixture.root)
        unc_path = chr(92) * 2 + 'server' + chr(92) + 'share' + chr(92) + 'task.json'
        document.write_text(unc_path, encoding='utf-8')
        self.fixture.refresh('1.0.2')
        with self.assertRaisesRegex(ValueError, 'DEVICE_SPECIFIC_HOME_PATH_FOUND'):
            portable.validate_tree(self.fixture.root)
        unicode_unc = chr(92) * 2 + 'server' + chr(92) + '共享' + chr(92) + 'task.json'
        document.write_text(unicode_unc, encoding='utf-8')
        self.fixture.refresh('1.0.2')
        with self.assertRaisesRegex(ValueError, 'DEVICE_SPECIFIC_HOME_PATH_FOUND'):
            portable.validate_tree(self.fixture.root)
        posix_home = chr(47) + 'ho' + 'me' + chr(47) + 'private-device' + chr(47) + 'artifact.json'
        document.write_text(posix_home, encoding='utf-8')
        self.fixture.refresh('1.0.2')
        with self.assertRaisesRegex(ValueError, 'DEVICE_SPECIFIC_HOME_PATH_FOUND'):
            portable.validate_tree(self.fixture.root)
        concrete_group = 'https://www.face' + 'book.com/groups/' + 'contest-moms' + '/'
        document.write_text(concrete_group, encoding='utf-8')
        self.fixture.refresh('1.0.3')
        with self.assertRaisesRegex(ValueError, 'CONCRETE_FACEBOOK_GROUP_URL_FOUND'):
            portable.validate_tree(self.fixture.root)
        document.write_text('synthetic neutral content', encoding='utf-8')
        self.fixture.refresh('1.0.4')
        with self.assertRaisesRegex(ValueError, 'CALLER_FORBIDDEN_TASK_TOKEN_FOUND'):
            portable.validate_tree(self.fixture.root, ['neutral content'])
        credential = 'access_' + 'token=' + 'a' * 24
        document.write_text(credential, encoding='utf-8')
        self.fixture.refresh('1.0.5')
        with self.assertRaisesRegex(ValueError, 'POSSIBLE_CREDENTIAL_FOUND'):
            portable.validate_tree(self.fixture.root)

    def test_synthetic_group_fixture_is_allowed(self):
        document = self.fixture.root / 'references' / 'evolution.md'
        document.write_text('https://www.facebook.com/groups/synthetic.fixture/\nhttps://www.facebook.com/groups/${groupSlug}/', encoding='utf-8')
        self.fixture.refresh('1.0.1')
        self.assertEqual(portable.validate_tree(self.fixture.root)['manifest']['version'], '1.0.1')

    def test_archive_path_traversal_and_hash_tamper_are_rejected(self):
        unsafe = self.base / 'unsafe.zip'
        with zipfile.ZipFile(unsafe, 'w') as handle:
            handle.writestr(f'{portable.NAME}/../escape.txt', 'bad')
        with self.assertRaisesRegex(ValueError, 'UNSAFE_ARCHIVE_MEMBER'):
            portable.verify_archive(unsafe)
        backslash = self.base / 'backslash.zip'
        with zipfile.ZipFile(backslash, 'w') as handle:
            handle.writestr(f'{portable.NAME}/scripts/foo\\..\\..\\escaped.py', 'bad')
        with self.assertRaisesRegex(ValueError, 'UNSAFE_ARCHIVE_MEMBER'):
            portable.verify_archive(backslash)
        symlink = self.base / 'symlink.zip'
        entry = zipfile.ZipInfo(f'{portable.NAME}/SKILL.md')
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(symlink, 'w') as handle:
            handle.writestr(entry, 'target')
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_SYMLINK_NOT_ALLOWED'):
            portable.verify_archive(symlink)
        alias = self.base / 'alias.zip'
        with zipfile.ZipFile(alias, 'w') as handle:
            handle.writestr(f'{portable.NAME}/scripts/./portable.py', 'bad alias')
        with self.assertRaisesRegex(ValueError, 'NON_CANONICAL_ARCHIVE_MEMBER'):
            portable.verify_archive(alias)
        collision = self.base / 'case-collision.zip'
        with zipfile.ZipFile(collision, 'w') as handle:
            handle.writestr(f'{portable.NAME}/scripts/Case.py', 'upper')
            handle.writestr(f'{portable.NAME}/scripts/case.py', 'lower')
        with self.assertRaisesRegex(ValueError, 'CASE_OR_UNICODE_PATH_COLLISION'):
            portable.verify_archive(collision)
        valid = self.base / 'valid.zip'
        portable.package_skill(self.fixture.root, valid)
        tampered = self.base / 'tampered.zip'
        with zipfile.ZipFile(valid, 'r') as source, zipfile.ZipFile(tampered, 'w') as target:
            for item in source.infolist():
                data = source.read(item)
                if item.filename.endswith('/SKILL.md'):
                    data += b'tamper'
                target.writestr(item, data)
        with self.assertRaisesRegex(ValueError, 'MANIFEST_CONTENT_MISMATCH'):
            portable.verify_archive(tampered)

    def test_transactional_source_install_requires_replace_and_keeps_backup(self):
        skills = self.base / 'skills'
        first = portable.install_source(self.fixture.root, skills)
        target = skills / portable.NAME
        self.assertEqual(first['status'], 'installed')
        self.assertEqual(portable.inventory(target), portable.inventory(self.fixture.root))
        self.assertEqual(portable.install_source(self.fixture.root, skills)['status'], 'already_current')
        (self.fixture.root / 'SKILL.md').write_text('synthetic revision two', encoding='utf-8')
        self.fixture.refresh('1.1.0')
        with self.assertRaisesRegex(ValueError, 'TARGET_EXISTS_USE_REPLACE'):
            portable.install_source(self.fixture.root, skills)
        second = portable.install_source(self.fixture.root, skills, replace=True)
        self.assertEqual(second['status'], 'installed')
        self.assertTrue(Path(second['backup']).is_dir())
        self.assertEqual(portable.inventory(target), portable.inventory(self.fixture.root))

    def test_verified_archive_installs_to_isolated_skills_directory(self):
        archive, skills = self.base / 'portable.zip', self.base / 'archive-skills'
        portable.package_skill(self.fixture.root, archive)
        result = portable.install_archive(archive, skills)
        self.assertEqual(result['status'], 'installed')
        self.assertEqual(portable.validate_tree(skills / portable.NAME)['manifest']['version'], '1.0.0')

    def test_skills_directory_precedence_is_environment_neutral(self):
        home = self.base / 'home'
        self.assertEqual(portable.resolve_skills_dir(env={}, home=home), (home / '.codex' / 'skills').resolve())
        self.assertEqual(
            portable.resolve_skills_dir(env={'CODEX_HOME': str(self.base / 'codex')}, home=home),
            (self.base / 'codex' / 'skills').resolve(),
        )
        self.assertEqual(
            portable.resolve_skills_dir(env={'FB_GROUP_POSTS_SKILLS_DIR': str(self.base / 'custom')}, home=home),
            (self.base / 'custom').resolve(),
        )

    def test_taskmaster_readiness_requires_executable_or_verified_windows_wrapper_and_skill_identity(self):
        skill = self.base / 'eric-task-master' / 'SKILL.md'
        skill.parent.mkdir(parents=True)
        skill.write_text('---\nname: unrelated-skill\n---\n', encoding='utf-8')
        self.assertFalse(portable.taskmaster_skill_compatible(skill))
        skill.write_text('---\nname: eric-task-master\n---\n', encoding='utf-8')
        self.assertTrue(portable.taskmaster_skill_compatible(skill))
        launcher = self.base / ('taskmaster.cmd' if os.name == 'nt' else 'taskmaster')
        if os.name == 'nt':
            launcher = self.base / 'bin' / 'taskmaster.cmd'
            runtime = self.base / 'runtime' / 'node.exe'
            cli = self.base / 'app' / 'src' / 'cli.mjs'
            launcher.parent.mkdir(); runtime.parent.mkdir(); cli.parent.mkdir(parents=True)
            runtime.write_bytes(b'synthetic'); cli.write_text('// synthetic', encoding='utf-8')
            launcher.write_text('@"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\src\\cli.mjs" %*\n', encoding='utf-8')
            self.assertEqual(portable.taskmaster_launcher_compatible(str(launcher)), (True, 'verified_cmd_layout'))
            launcher.write_text('@echo unsupported\n', encoding='utf-8')
            self.assertEqual(portable.taskmaster_launcher_compatible(str(launcher)), (False, 'unsupported_cmd_layout'))
        else:
            launcher.write_text('#!/bin/sh\nexit 0\n', encoding='utf-8')
            launcher.chmod(0o644)
            self.assertIsNone(portable.resolve_program(str(launcher)))
            self.assertEqual(portable.taskmaster_launcher_compatible(str(launcher)), (False, 'not_executable'))
            launcher.chmod(0o755)
            self.assertEqual(portable.resolve_program(str(launcher)), str(launcher.resolve()))
            self.assertEqual(portable.taskmaster_launcher_compatible(str(launcher)), (True, 'posix_executable'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
