import json
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

import common
from vekit import resources
from vekit.resources import GpuSlots


class Clock:
    """A clock the test moves; file times are set to it explicitly."""

    def __init__(self, now=1_000_000.0):
        self.t = now

    def __call__(self):
        return self.t


class SlotsCase(common.Case):
    def setUp(self):
        super().setUp()
        self.dir = self.tmp / "gpu"
        self.dir.mkdir()
        self.clock = Clock(time.time())

    def limits(self, total, per_job):
        (self.dir / "limits.json").write_text(json.dumps({"total": total, "perJob": per_job}))

    def slots(self, job, **kw):
        kw.setdefault("clock", self.clock)
        kw.setdefault("poll_s", 0.001)
        return GpuSlots(self.dir, job, **kw)

    def write_slot(self, i, job, pid, age=0.0):
        p = self.dir / f"slot-{i}"
        p.write_text(json.dumps({"jobId": job, "pid": pid, "at": int(self.clock() * 1000)}))
        t = self.clock() - age
        os.utime(p, (t, t))
        return p

    def names(self):
        return sorted(p.name for p in self.dir.iterdir() if p.name.startswith("slot-"))


class ProtocolTest(SlotsCase):
    def test_takes_the_first_free_slot_and_writes_the_documented_body(self):
        self.limits(3, 3)
        s = self.slots("job-a", pid=4242)
        with s.slot() as held:
            self.assertEqual(held.path.name, "slot-0")
            body = json.loads(held.path.read_text())
            self.assertEqual(set(body), {"jobId", "pid", "at"})
            self.assertEqual((body["jobId"], body["pid"]), ("job-a", 4242))
            self.assertEqual(body["at"], int(self.clock() * 1000))
        self.assertEqual(self.names(), [])

    def test_never_more_than_per_job(self):
        self.limits(4, 2)
        s = self.slots("job-a")
        h1 = s.acquire()
        h2 = s._try_once()
        # the third attempt finds this job at its per-job limit although two slots are free
        self.assertIsNotNone(h2)
        self.assertIsNone(s._try_once())
        self.assertEqual(len(self.names()), 2)
        h1.release()
        self.assertIsNotNone(s._try_once())

    def test_total_is_shared_between_jobs(self):
        self.limits(2, 2)
        a, b = self.slots("a"), self.slots("b")
        self.assertIsNotNone(a._try_once())
        self.assertIsNotNone(b._try_once())
        self.assertIsNone(a._try_once())
        self.assertIsNone(b._try_once())

    def test_waits_and_retries_until_a_slot_is_free(self):
        self.limits(1, 1)
        other = self.slots("other")
        held = other.acquire()
        waited = []

        def sleep(s):
            waited.append(s)
            if len(waited) == 3:
                held.release()

        mine = self.slots("mine", sleep=sleep, poll_s=1.0)
        got = mine.acquire()
        self.assertEqual(len(waited), 3)
        self.assertTrue(all(1.0 <= w <= 1.11 for w in waited))
        self.assertEqual(json.loads(got.path.read_text())["jobId"], "mine")
        got.release()

    def test_logs_once_while_waiting(self):
        self.limits(1, 1)
        held = self.slots("other").acquire()
        said, n = [], []

        def sleep(_):
            n.append(1)
            if len(n) == 4:
                held.release()

        self.slots("mine", sleep=sleep, log=said.append).acquire().release()
        self.assertEqual(len(said), 1)

    def test_limits_are_read_at_every_attempt(self):
        self.limits(1, 1)
        a = self.slots("a")
        self.assertIsNotNone(a._try_once())
        self.assertIsNone(a._try_once())
        self.limits(2, 2)                      # the server raised the limit
        self.assertIsNotNone(a._try_once())

    def test_missing_or_damaged_limits_mean_one_slot(self):
        s = self.slots("a")
        self.assertEqual(s.limits(), (1, 1))
        (self.dir / "limits.json").write_text("{not json")
        self.assertEqual(s.limits(), (1, 1))
        self.limits(2, 9)
        self.assertEqual(s.limits(), (2, 2))   # perJob never exceeds total

    def test_stale_by_lease(self):
        self.limits(1, 1)
        me = os.getpid()
        self.write_slot(0, "ghost", me, age=15 * 60 - 30)       # still within the lease
        s = self.slots("a")
        self.assertIsNone(s._try_once())
        self.write_slot(0, "ghost", me, age=15 * 60 + 5)        # lease over, though its process "lives"
        got = s._try_once()
        self.assertIsNotNone(got)
        self.assertEqual(json.loads(got.read_text())["jobId"], "a")
        self.assertEqual([n for n in os.listdir(self.dir) if "taken" in n], [])

    def test_stale_by_dead_process(self):
        self.limits(1, 1)
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        self.write_slot(0, "ghost", dead.pid, age=1)
        got = self.slots("a", alive=resources.pid_alive)._try_once()
        self.assertIsNotNone(got)

    def test_live_process_keeps_its_slot(self):
        self.limits(1, 1)
        self.write_slot(0, "other", os.getpid(), age=1)
        self.assertIsNone(self.slots("a", alive=resources.pid_alive)._try_once())

    def test_release_deletes_only_its_own_file(self):
        self.limits(1, 1)
        s = self.slots("a", pid=1111)
        held = s.acquire()
        os.unlink(held.path)                                    # taken over by somebody ...
        self.write_slot(0, "b", 2222)                           # ... who now owns the name
        held.release()
        self.assertEqual(json.loads((self.dir / "slot-0").read_text())["jobId"], "b")

    def test_renewal_updates_the_modified_time(self):
        self.limits(1, 1)
        s = self.slots("a", renew_s=0.02)
        held = s.acquire()
        os.utime(held.path, (1, 1))
        deadline = time.time() + 5
        while os.stat(held.path).st_mtime < 1000 and time.time() < deadline:
            time.sleep(0.01)
        self.assertGreater(os.stat(held.path).st_mtime, 1000)
        held.release()

    def test_racing_threads_never_exceed_the_limit(self):
        self.limits(2, 2)
        inside, peak, lock = [0], [0], threading.Lock()
        errors = []

        def work(i):
            try:
                s = GpuSlots(self.dir, f"job{i}", poll_s=0.002)
                for _ in range(5):
                    with s.slot():
                        with lock:
                            inside[0] += 1
                            peak[0] = max(peak[0], inside[0])
                        time.sleep(0.003)
                        with lock:
                            inside[0] -= 1
            except Exception as e:                              # pragma: no cover
                errors.append(e)

        threads = [threading.Thread(target=work, args=(i,)) for i in range(6)]
        [t.start() for t in threads]
        [t.join(30) for t in threads]
        self.assertEqual(errors, [])
        self.assertLessEqual(peak[0], 2)
        self.assertEqual(self.names(), [])

    def test_two_programs_of_one_job_stay_within_per_job(self):
        # same job id from several threads (one job running two toolkit programs at once)
        self.limits(4, 2)
        peak, now, lock = [0], [0], threading.Lock()

        def work():
            s = GpuSlots(self.dir, "same", poll_s=0.002)
            for _ in range(4):
                with s.slot():
                    with lock:
                        now[0] += 1
                        peak[0] = max(peak[0], now[0])
                    time.sleep(0.003)
                    with lock:
                        now[0] -= 1

        ts = [threading.Thread(target=work) for _ in range(5)]
        [t.start() for t in ts]
        [t.join(30) for t in ts]
        self.assertLessEqual(peak[0], 2)

    def test_take_over_gives_a_fresh_slot_back(self):
        self.limits(1, 1)
        s = self.slots("a")
        path = self.dir / "slot-0"
        old = self.write_slot(0, "ghost", 1, age=3600)
        seen = s._read(path)
        # between our look and our rename another program replaced the stale file with a fresh one
        os.unlink(old)
        self.write_slot(0, "fresh", os.getpid())
        self.assertTrue(s._take_over(path, seen))
        self.assertEqual(json.loads(path.read_text())["jobId"], "fresh")


class PidTest(common.Case):
    def test_pid_alive(self):
        self.assertTrue(resources.pid_alive(os.getpid()))
        self.assertFalse(resources.pid_alive(0))
        self.assertFalse(resources.pid_alive(-5))
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        self.assertFalse(resources.pid_alive(p.pid))


class GpuSlotEnvironmentTest(SlotsCase):
    def test_without_the_variables_it_yields_at_once(self):
        with resources.gpu_slot():
            self.assertEqual(os.listdir(self.dir), [])
        self.env(VE_GPU_SLOTS_DIR=str(self.dir))                 # job id missing: still no slot
        with resources.gpu_slot():
            self.assertEqual(os.listdir(self.dir), [])
        self.env(VE_JOB_ID="j")
        os.environ.pop("VE_GPU_SLOTS_DIR")
        with resources.gpu_slot():
            self.assertEqual(os.listdir(self.dir), [])

    def test_with_the_variables_a_slot_is_held_for_the_block_and_nesting_takes_no_second(self):
        self.limits(2, 2)
        self.env(VE_GPU_SLOTS_DIR=str(self.dir), VE_JOB_ID="job-x")
        with resources.gpu_slot():
            self.assertEqual(self.names(), ["slot-0"])
            with resources.gpu_slot():
                self.assertEqual(self.names(), ["slot-0"])
        self.assertEqual(self.names(), [])

    def test_slot_is_released_on_error(self):
        self.limits(1, 1)
        self.env(VE_GPU_SLOTS_DIR=str(self.dir), VE_JOB_ID="job-x")
        with self.assertRaises(RuntimeError):
            with resources.gpu_slot():
                raise RuntimeError("boom")
        self.assertEqual(self.names(), [])

    def test_gpu_task_takes_a_slot_only_when_the_gpu_is_used(self):
        self.limits(1, 1)
        self.env(VE_GPU_SLOTS_DIR=str(self.dir), VE_JOB_ID="job-x", VE_HW="none")
        with resources.gpu_task("h264", "prores"):
            self.assertEqual(self.names(), [])


class OtherProgramsTest(SlotsCase):
    def test_a_python_process_holds_a_slot_and_a_second_one_waits_for_it(self):
        """Two real processes: the second really waits until the first has left the block."""
        self.limits(1, 1)
        code = (
            "import sys, time\n"
            f"sys.path.insert(0, {str(common.KIT)!r})\n"
            "from vekit import resources\n"
            "with resources.gpu_slot():\n"
            "    print('in', flush=True)\n"
            "    time.sleep(float(sys.argv[1]))\n"
            "print('out', flush=True)\n")
        env = common.clean_env(VE_GPU_SLOTS_DIR=str(self.dir), VE_JOB_ID="p1", PYTHONDONTWRITEBYTECODE="1")
        first = subprocess.Popen([sys.executable, "-c", code, "0.6"], env=env, stdout=subprocess.PIPE, text=True)
        self.assertEqual(first.stdout.readline().strip(), "in")
        t0 = time.time()
        second = subprocess.run([sys.executable, "-c", code, "0"], env=dict(env, VE_JOB_ID="p2"),
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertGreaterEqual(time.time() - t0, 0.3)
        self.assertIn("waiting for a GPU slot", second.stderr)
        first.communicate(timeout=30)
        first.stdout.close()
        self.assertEqual(self.names(), [])

    def test_a_killed_holder_frees_its_slot(self):
        self.limits(1, 1)
        code = (
            "import sys, time\n"
            f"sys.path.insert(0, {str(common.KIT)!r})\n"
            "from vekit import resources\n"
            "with resources.gpu_slot():\n"
            "    print('in', flush=True)\n"
            "    time.sleep(60)\n")
        env = common.clean_env(VE_GPU_SLOTS_DIR=str(self.dir), VE_JOB_ID="doomed", PYTHONDONTWRITEBYTECODE="1")
        p = subprocess.Popen([sys.executable, "-c", code], env=env, stdout=subprocess.PIPE, text=True)
        self.assertEqual(p.stdout.readline().strip(), "in")
        p.kill()
        p.wait()
        p.stdout.close()
        self.assertEqual(self.names(), ["slot-0"])               # left behind by the kill
        got = self.slots("next", alive=resources.pid_alive)._try_once()
        self.assertIsNotNone(got)


if __name__ == "__main__":
    unittest.main()
