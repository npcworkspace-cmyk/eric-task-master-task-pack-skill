"""Offline evolution tests. Small synthetic skills avoid recursively validating this suite."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'evolve.py'
spec = importlib.util.spec_from_file_location('skill_evolve', SCRIPT)
evolve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evolve)


class Fixture:
    def __init__(self, base, legacy=False):
        self.source = base / 'facebook-group-posts'
        self.workspace = base / 'task-work'
        files = {
            'SKILL.md': '---\nname: facebook-group-posts\ndescription: synthetic test skill\n---\n',
            'scripts/collect.mjs': 'export const value = 1;\n',
            'scripts/batches.mjs': 'export const value = 1;\n',
            'scripts/audit_export.py': 'VALUE = 1\n',
            'references/method.md': 'Synthetic technical method.\n',
            'tests/test-collector.mjs': "import assert from 'node:assert/strict';import {value} from '../scripts/collect.mjs';assert.equal(value,1);\n",
            'tests/test-batches.mjs': "import assert from 'node:assert/strict';import {value} from '../scripts/batches.mjs';assert.equal(value,1);\n",
            'tests/test-audit-export.py': "from pathlib import Path\nassert (Path(__file__).resolve().parents[1]/'scripts/audit_export.py').read_text() == 'VALUE = 1\\n'\n",
        }
        if not legacy:
            files['scripts/evolve.py'] = '# synthetic evolution implementation fixture\n'
            files['tests/test-evolve.py'] = "from pathlib import Path\nassert (Path(__file__).resolve().parents[1]/'SKILL.md').exists()\n"
            files['scripts/portable.py'] = '# synthetic portable implementation fixture\n'
            files['tests/test-portable.py'] = "from pathlib import Path\nassert (Path(__file__).resolve().parents[1]/'scripts/portable.py').exists()\n"
        for name, content in files.items():
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
        evolve.write(self.source / 'pack-manifest.json', dict(name=evolve.NAME, version='1.0.0', files=[]))
        actual = evolve.inventory(self.source)
        evolve.write(self.source / 'pack-manifest.json', dict(name=evolve.NAME, version='1.0.0', files=[
            dict(path=name, bytes=(self.source / name).stat().st_size, sha256=sha)
            for name, sha in actual.items() if name != 'pack-manifest.json']))

    def stage(self):
        self.workspace.mkdir(parents=True, exist_ok=True)
        evidence = self.workspace / 'synthetic-evidence.json'
        evidence.write_text('{"fixture": "offline technical regression"}')
        evolve.review(self.workspace, 'partial', 'candidate', 'General technical correction.', True, [evidence])
        candidate = Path(evolve.stage(self.workspace, self.source)['candidate'])
        (candidate / 'references/method.md').write_text('Improved synthetic technical method.\n', encoding='utf-8')
        return candidate

    def tests_review(self, candidate):
        transaction = evolve.read(candidate.parent / 'transaction.json')
        value = evolve.test_review_binding(transaction['source_files'], evolve.inventory(candidate))
        evidence = self.workspace / 'synthetic-evidence.json'
        value.update(decision='approved', reviewer='Synthetic independent reviewer',
                     reason='Reviewed synthetic test change and retained a meaningful assertion.',
                     evidence=[dict(path=str(evidence), sha256=evolve.digest(evidence))])
        file = self.workspace / 'tests-review.json'
        evolve.write(file, value)
        return file


def successful_runner(command, **kwargs):
    """Explicit fake runner: used only to exercise transaction failures and rollback."""
    assert kwargs['shell'] is False
    return subprocess.CompletedProcess(command, 0, 'synthetic runner', '')


class EvolutionTests(unittest.TestCase):
    def setUp(self):
        # Keep fixtures in the outer task workspace, rather than nesting another
        # full validation workspace below the current check's long TMP path.
        temp_root = Path(os.environ.get('FB_SKILL_EVOLUTION_TEST_WORKSPACE', tempfile.gettempdir()))
        temp_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='e-', dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.fixture = Fixture(self.base)

    def test_no_change_receipt_is_valid_and_does_not_edit_source(self):
        before = evolve.inventory(self.fixture.source)
        result = evolve.review(self.fixture.workspace, 'complete', 'no_change', 'No new reusable evidence.')
        self.assertFalse(result['changed_skill'])
        marker = evolve.read(self.fixture.workspace / 'evolution-review-status.json')
        self.assertEqual(marker['status'], 'completed')
        self.assertFalse(marker['review_required'])
        self.assertEqual(marker['decision'], 'no_change')
        self.assertEqual(evolve.inventory(self.fixture.source), before)
        with self.assertRaisesRegex(ValueError, 'AGENT_TECHNICAL_REVIEW_REQUIRED'):
            evolve.stage(self.fixture.workspace, self.fixture.source)

    def test_candidate_requires_agent_technical_assessment(self):
        with self.assertRaisesRegex(ValueError, 'AGENT_TECHNICAL_REVIEW_REQUIRED'):
            evolve.review(self.fixture.workspace, 'failed', 'candidate', 'A proposed correction.')

    def test_stage_is_isolated_and_source_manifest_is_checked(self):
        before = evolve.inventory(self.fixture.source)
        candidate = self.fixture.stage()
        self.assertNotEqual(evolve.inventory(candidate), before)
        self.assertEqual(evolve.inventory(self.fixture.source), before)
        (self.fixture.source / 'references/method.md').write_text('Unmanifested change.')
        with self.assertRaisesRegex(ValueError, 'MANIFEST_HASH_MISMATCH'):
            evolve.stage(self.fixture.workspace, self.fixture.source)

    def test_real_offline_checks_execute_and_version_manifest_refresh(self):
        candidate = self.fixture.stage()
        result = evolve.validate(self.fixture.workspace, candidate)
        self.assertTrue(result['passed'])
        self.assertEqual(len(result['checks']), 9)
        self.assertTrue(result['baseline_passed'])
        self.assertTrue(result['candidate_passed'])
        self.assertTrue(all(item['exit_code'] == 0 and Path(item['log']).exists() for item in result['checks']))
        self.assertTrue(all(item['cwd'] == str(self.fixture.workspace.resolve()) for item in result['checks']))
        self.assertEqual(evolve.read(candidate / 'pack-manifest.json')['version'], '1.0.1')
        evolve.manifest_matches(candidate, evolve.inventory(candidate))

    def test_selected_runtime_paths_propagate_to_nested_evolution_tests(self):
        candidate = self.fixture.stage()
        environments = []
        def runner(command, **kwargs):
            environments.append(kwargs['env'])
            return subprocess.CompletedProcess(command, 0, 'synthetic runner', '')
        executable = str(Path(sys.executable).resolve())
        evolve.validate(self.fixture.workspace, candidate, python=executable, node=executable, runner=runner)
        self.assertTrue(environments)
        self.assertTrue(all(value['FB_GROUP_POSTS_PYTHON'] == executable for value in environments))
        self.assertTrue(all(value['FB_GROUP_POSTS_NODE'] == executable for value in environments))

    def test_forged_pass_does_not_bypass_actual_promotion_checks(self):
        candidate = self.fixture.stage()
        before = evolve.inventory(self.fixture.source)
        evolve.write(candidate.parent / 'validation.json', dict(passed=True))
        (candidate / 'scripts/collect.mjs').write_text('export const value = 2;\n')
        with self.assertRaisesRegex(ValueError, 'OFFLINE_CHECK_FAILED'):
            evolve.promote(self.fixture.workspace, candidate)
        self.assertEqual(evolve.inventory(self.fixture.source), before)

    def test_changed_candidate_core_test_requires_independent_bound_review(self):
        candidate = self.fixture.stage()
        (candidate / 'scripts/collect.mjs').write_text('export const value = 2;\n')
        (candidate / 'tests/test-collector.mjs').write_text('// Removed assertions in candidate.\n')
        with self.assertRaisesRegex(ValueError, 'TEST_DIFF_REVIEW_REQUIRED'):
            evolve.validate(self.fixture.workspace, candidate)

    def test_new_candidate_test_is_also_executed(self):
        candidate = self.fixture.stage()
        (candidate / 'tests/test-new-case.py').write_text("raise RuntimeError('synthetic new-test failure')\n")
        with self.assertRaisesRegex(ValueError, 'OFFLINE_CHECK_FAILED'):
            evolve.validate(self.fixture.workspace, candidate, tests_review=self.fixture.tests_review(candidate))

    def test_legacy_source_without_evolution_can_upgrade(self):
        fixture = Fixture(self.base / 'legacy', legacy=True)
        candidate = fixture.stage()
        (candidate / 'scripts/evolve.py').write_text('# New evolution helper in candidate.\n')
        (candidate / 'tests/test-evolve.py').write_text('assert True\n')
        (candidate / 'scripts/portable.py').write_text('# New portable helper in candidate.\n')
        (candidate / 'tests/test-portable.py').write_text('assert True\n')
        (candidate / 'pack-manifest.json').write_text(json.dumps(dict(name=evolve.NAME, version='1.1.0', files=[])))
        result = evolve.validate(fixture.workspace, candidate, tests_review=fixture.tests_review(candidate))
        self.assertEqual(len(result['checks']), 7)
        self.assertEqual(evolve.read(candidate / 'pack-manifest.json')['version'], '1.1.0')
        promoted = evolve.promote(fixture.workspace, candidate, runner=successful_runner)
        self.assertEqual(promoted['phase'], 'promoted')
        _, transaction = evolve.transaction_for(fixture.workspace, candidate)
        self.assertEqual(transaction['phase'], 'promoted')
        rolled_back = evolve.rollback(fixture.workspace, candidate)
        self.assertEqual(rolled_back['phase'], 'rolled_back')
        self.assertFalse((fixture.source / 'scripts' / 'portable.py').exists())
        self.assertEqual(evolve.read(fixture.source / 'pack-manifest.json')['version'], '1.0.0')

    def test_source_drift_refuses_promotion(self):
        candidate = self.fixture.stage()
        (self.fixture.source / 'references/method.md').write_text('Another editor changed this.')
        with self.assertRaisesRegex(ValueError, 'SOURCE_DRIFT_RESTAGE_REQUIRED'):
            evolve.promote(self.fixture.workspace, candidate, runner=successful_runner)

    def test_allowlist_and_core_test_deletion_are_rejected(self):
        candidate = self.fixture.stage()
        (candidate / 'posts.json').write_text('[]')
        with self.assertRaisesRegex(ValueError, 'FILE_OUTSIDE_TECHNICAL_ALLOWLIST'):
            evolve.validate(self.fixture.workspace, candidate, runner=successful_runner)
        (candidate / 'posts.json').unlink()
        (candidate / 'tests/test-collector.mjs').unlink()
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_CORE_TESTS_REQUIRED'):
            evolve.validate(self.fixture.workspace, candidate, runner=successful_runner)

    def test_candidate_changed_during_checks_is_rejected(self):
        candidate = self.fixture.stage()
        def mutate(command, **kwargs):
            (candidate / 'references/method.md').write_text('Concurrent candidate edit.')
            return successful_runner(command, **kwargs)
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_CHANGED_DURING_CHECKS'):
            evolve.validate(self.fixture.workspace, candidate, runner=mutate)

    def test_partial_write_failure_restores_backup(self):
        candidate = self.fixture.stage()
        before = evolve.inventory(self.fixture.source)
        calls = []
        def fail_second(source, target):
            calls.append(str(target))
            if len(calls) == 2:
                raise OSError('synthetic write failure')
            evolve.atomic_copy(source, target)
        with self.assertRaisesRegex(OSError, 'synthetic write failure'):
            evolve.promote(self.fixture.workspace, candidate, runner=successful_runner, replace=fail_second)
        self.assertEqual(evolve.inventory(self.fixture.source), before)
        self.assertEqual(evolve.read(candidate.parent / 'transaction.json')['phase'], 'rolled_back')
        self.assertFalse((self.fixture.source / evolve.LOCK).exists())

    def test_successful_promotion_and_explicit_rollback_are_local(self):
        candidate = self.fixture.stage()
        before = evolve.inventory(self.fixture.source)
        result = evolve.promote(self.fixture.workspace, candidate, runner=successful_runner)
        self.assertEqual(result['phase'], 'promoted')
        self.assertEqual(result['version'], '1.0.1')
        self.assertFalse(result['browser_task_restarted'])
        self.assertTrue(Path(result['backup']).is_relative_to(self.fixture.workspace))
        self.assertEqual(evolve.inventory(self.fixture.source), evolve.inventory(candidate))
        evolve.rollback(self.fixture.workspace, candidate)
        self.assertEqual(evolve.inventory(self.fixture.source), before)

    def test_rollback_refuses_unrelated_source_changes(self):
        candidate = self.fixture.stage()
        evolve.promote(self.fixture.workspace, candidate, runner=successful_runner)
        (self.fixture.source / 'references/method.md').write_text('Later unrelated technical edit.')
        with self.assertRaisesRegex(ValueError, 'SOURCE_DRIFT_DURING_ROLLBACK'):
            evolve.rollback(self.fixture.workspace, candidate)

    def test_review_and_original_snapshot_tampering_are_detected(self):
        candidate = self.fixture.stage()
        transaction = evolve.read(candidate.parent / 'transaction.json')
        receipt = Path(transaction['review_file'])
        receipt.write_text(receipt.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'REVIEW_RECEIPT_CHANGED'):
            evolve.validate(self.fixture.workspace, candidate, runner=successful_runner)

    def test_task_workspace_cannot_be_inside_skill(self):
        with self.assertRaisesRegex(ValueError, 'RECEIPTS_MUST_STAY_OUTSIDE_SKILL'):
            evolve.review(self.fixture.source / 'task', 'paused', 'no_change', 'Synthetic.')

    def test_candidate_needs_real_task_local_immutable_evidence(self):
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_REQUIRES_ACTUAL_EVIDENCE'):
            evolve.review(self.fixture.workspace, 'failed', 'candidate', 'Synthetic.', True)
        candidate = self.fixture.stage()
        (self.fixture.workspace / 'synthetic-evidence.json').write_text('Changed evidence.')
        with self.assertRaisesRegex(ValueError, 'REVIEW_EVIDENCE_CHANGED'):
            evolve.validate(self.fixture.workspace, candidate, runner=successful_runner)

    def test_long_check_directory_still_executes_from_short_task_workspace(self):
        padding = max(1, 208 - len(str(self.base)))
        fixture = Fixture(self.base / ('d' * padding))
        candidate = fixture.stage()
        result = evolve.validate(fixture.workspace, candidate,
                                 python=getattr(sys, '_base_executable', sys.executable))
        self.assertTrue(result['passed'])
        self.assertTrue(all(item['cwd'] == str(fixture.workspace.resolve()) for item in result['checks']))
        self.assertGreater(len(str(Path(result['checks'][0]['log']).parent)), 260)

    def test_changed_source_after_test_review_invalidates_exact_binding(self):
        candidate = self.fixture.stage()
        (candidate / 'tests/test-new-case.py').write_text('assert True\n')
        receipt = self.fixture.tests_review(candidate)
        (candidate / 'references/method.md').write_text('Later unreviewed technical change.')
        with self.assertRaisesRegex(ValueError, 'TEST_REVIEW_BINDING_CHANGED'):
            evolve.validate(self.fixture.workspace, candidate, tests_review=receipt, runner=successful_runner)

    def test_failing_baseline_is_visible_while_candidate_must_pass(self):
        (self.fixture.source / 'scripts/collect.mjs').write_text('export const value = 2;\n')
        evolve.refresh_manifest(self.fixture.source, '0.0.0')
        candidate = self.fixture.stage()
        (candidate / 'scripts/collect.mjs').write_text('export const value = 1;\n')
        result = evolve.validate(self.fixture.workspace, candidate)
        self.assertFalse(result['baseline_passed'])
        self.assertTrue(result['candidate_passed'])
        self.assertTrue(any(item['exit_code'] != 0 for item in result['checks'] if item['group'] == 'baseline'))


if __name__ == '__main__':
    unittest.main()
