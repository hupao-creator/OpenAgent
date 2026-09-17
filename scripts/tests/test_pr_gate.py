import contextlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import pr_gate_lib as lib

spec = importlib.util.spec_from_file_location("pr_gate", SCRIPTS / "pr-gate.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)

USER = {"login": lib.BOT}
HEAD = "abcdef0123456789" + "0" * 24
BASE = "b" * 40
PROOF = "scope-v2:scoped:" + HEAD + ":" + BASE
REVIEW = {"id": 1, "user": USER, "state": "COMMENTED", "commit_id": "head", "submitted_at": "2026-09-11T10:00:00Z"}
REQUEST = {"id": 2, "user": {"login": "human"}, "body": "@codex review", "created_at": "2026-09-11T11:00:00Z", "author_association": "COLLABORATOR"}
ANSWERED = {**REVIEW, "commit_id": HEAD, "submitted_at": "2026-09-11T12:00:00Z"}
SUMMARY = {"id": 9, "user": USER, "updated_at": "2026-09-11T12:00:01Z",
           "body": '<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-09-11T12:00:00Z">time</relative-time> | `abcdef0` | Manual request |'}
COMMENT_REVIEW = {"id": 90, "user": USER, "created_at": "2026-09-11T11:59:59Z", "updated_at": "2026-09-11T11:59:59Z",
                  "body": "Codex Review: Didn't find any major issues. Another round soon, please!\n\n**Reviewed commit:** `abcdef0123`"}
LIMIT_REPLY = {"id": 11, "user": USER, "body": "You have reached your Codex usage limits for code reviews.", "created_at": "2026-09-11T11:30:00Z"}
GATE_SUMMARY = {**SUMMARY, "id": 20, "created_at": "2026-09-11T12:00:03Z", "updated_at": "2026-09-11T12:00:03Z",
                "body": SUMMARY["body"].replace("12:00:00Z", "12:00:02Z")}


def classify(**changes):
    return lib.classify(**{"head": "head", "reviews": [], "comments": [], **changes})


def observation(**changes):
    return {"state": "submitted", "head": HEAD, "currentReview": REVIEW, "comments": [SUMMARY],
            "reviews": [REVIEW], "inlineComments": [], **changes}


def comment_observation(comments=None, reviews=None):
    comments = [REQUEST, COMMENT_REVIEW, SUMMARY] if comments is None else comments
    reviews = [] if reviews is None else reviews
    return {**classify(head=HEAD, comments=comments, reviews=reviews), "comments": comments, "reviews": reviews, "inlineComments": []}


class Clock:
    def __init__(self):
        self.time = 0

    def now(self):
        return self.time

    def wait(self, milliseconds):
        self.time += milliseconds

    def options(self):
        return {"timeout_ms": 100, "interval_ms": 10, "settle_ms": 20, "now": self.now, "wait": self.wait}


def thread(resolved=True, **changes):
    return {"id": "t1", "isResolved": resolved, "comments": {"nodes": [{"databaseId": 9, "url": "u1"}]}, **changes}


def graph(head=HEAD, threads=None):
    return [{"data": {"repository": {"pullRequest": {"headRefOid": head, "reviewThreads": {"nodes": [thread()] if threads is None else threads}}}}}]


def review_api(*, comments=None, reviews=None, head=HEAD, pr_state="open", posted=None):
    comments = [] if comments is None else comments
    reviews = [] if reviews is None else reviews
    posted = [] if posted is None else posted

    def api(args, deadline=math.inf):
        if "POST" in args:
            posted.append(args)
            return {"id": 7, "html_url": "url", "created_at": "2026-09-11T13:00:00Z"}
        path = args[-1]
        if path.endswith("/pulls/1"):
            return {"head": {"sha": head}, "state": pr_state, "html_url": "url"}
        if "/reviews?" in path:
            return [reviews]
        if "/pulls/1/comments?" in path or "/reactions?" in path:
            return [[]]
        if "/comments?" in path:
            return [comments]
        raise AssertionError(path)
    return api


def verification_run(conclusion="success", **changes):
    run = {"id": 5, "name": cli.VERIFICATION_CHECK, "status": "completed", "conclusion": conclusion,
           "output": {"summary": PROOF}, "app": {"id": 1}, "check_suite": {"id": 10}, **changes}
    if conclusion == "in_progress":
        run.update(status="in_progress")
        run.pop("conclusion")
    return run


def gate_base(**changes):
    return {"prState": "open", "draft": False, "mergeable": True, "mergeableState": "clean", "state": "submitted",
            "canRequest": True, "requestCount": 1, "head": HEAD, "currentReview": REVIEW, "comments": [SUMMARY],
            "inlineComments": [], "threads": [thread()],
            "baseSha": BASE, "verificationSnapshotStable": True,
            "statuses": [], "checkRuns": [verification_run()], **changes}


def gate_api(*, threads=None, verification="success"):
    base = review_api(comments=[REQUEST, GATE_SUMMARY], reviews=[ANSWERED])

    def api(args, deadline=math.inf):
        path = args[-1]
        if args[1] == "graphql":
            return graph(threads=threads)
        if path.endswith("/pulls/1"):
            return {"head": {"sha": HEAD}, "base": {"sha": BASE}, "state": "open", "draft": False, "mergeable": True, "mergeable_state": "clean"}
        if "/statuses?" in path:
            return [[]]
        if "/check-runs?" in path:
            return [{"check_runs": [verification_run(verification)]}]
        return base(args, deadline)
    return api


class ClassificationTests(unittest.TestCase):
    def test_absence_ordinary_messages_and_reactions_are_not_completion(self):
        for comments in ([], [{"user": USER, "body": "No issues found", "created_at": REQUEST["created_at"]}]):
            self.assertEqual(classify(comments=comments, reactions=[{"user": USER, "content": "+1"}])["state"], "unknown")

    def test_only_submitted_exact_bot_reviews_count(self):
        self.assertEqual(classify(reviews=[REVIEW])["state"], "submitted")
        for review in ({**REVIEW, "user": {"login": "codex-fake"}}, {**REVIEW, "state": "PENDING"}):
            self.assertEqual(classify(reviews=[review])["state"], "unknown")
        for review in ({**REVIEW, "state": "DISMISSED"}, {**REVIEW, "commit_id": "old"}):
            self.assertEqual(classify(reviews=[review])["state"], "stale")

    def test_new_request_invalidates_completion_and_eyes_only_acknowledge(self):
        self.assertEqual(classify(reviews=[REVIEW], comments=[REQUEST])["state"], "requested")
        self.assertEqual(classify(comments=[REQUEST], reactions=[{"user": USER, "content": "eyes"}])["state"], "acknowledged")
        self.assertEqual(classify(comments=[REQUEST], reactions=[{"user": {"login": "human"}, "content": "eyes"}])["state"], "requested")
        self.assertEqual(classify(reviews=[{**REVIEW, "submitted_at": ANSWERED["submitted_at"]}], comments=[REQUEST])["state"], "submitted")

    def test_quoted_or_untrusted_triggers_are_not_requests(self):
        for change in ({"body": "> @codex review"}, {"author_association": "CONTRIBUTOR"}):
            result = classify(comments=[{**REQUEST, **change}])
            self.assertIsNone(result["request"])
            self.assertEqual(result["requestCount"], 0)

    def test_answered_request_is_stale_not_in_flight(self):
        self.assertEqual(classify(reviews=[{**ANSWERED, "commit_id": "old"}], comments=[REQUEST])["state"], "stale")
        self.assertEqual(classify(reviews=[REVIEW], comments=[REQUEST])["state"], "requested")

    def test_outsider_answers_do_not_count_or_shadow_trusted_rounds(self):
        outsider = {**REQUEST, "id": 8, "author_association": "CONTRIBUTOR", "created_at": "2026-09-11T10:00:00Z"}
        answer = {**REVIEW, "submitted_at": "2026-09-11T10:30:00Z"}
        alone = classify(reviews=[answer], comments=[outsider])
        self.assertEqual((alone["state"], alone["chargeableRounds"]), ("unknown", 0))
        for comments in ([outsider, REQUEST], [REQUEST, {**outsider, "created_at": "2026-09-11T11:30:00Z"}]):
            result = classify(reviews=[answer, {**ANSWERED, "commit_id": "head"}], comments=comments)
            self.assertEqual((result["state"], result["chargeableRounds"]), ("submitted", 1 if comments[0] == outsider else 2))

    def test_p0_p1_rounds_are_free_but_other_and_dismissed_rounds_charge(self):
        rounds = [{**ANSWERED, "id": index} for index in range(3)]
        for badge in ("P0", "P1", "P2", "unknown"):
            finding = {"user": USER, "pull_request_review_id": 0, "body": "![{} Badge]".format(badge)}
            result = classify(comments=[REQUEST], reviews=rounds, inline=[finding])
            charged = 2 if badge in {"P0", "P1"} else 3
            self.assertEqual(result["chargeableRounds"], charged)
            self.assertEqual(result["requestsRemaining"], 3 - charged)
            self.assertEqual(result["canRequest"], charged < 3)
        dismissed = classify(comments=[REQUEST], reviews=[{**ANSWERED, "state": "DISMISSED"}])
        self.assertEqual((dismissed["chargeableRounds"], dismissed["state"]), (1, "stale"))

    def test_free_rounds_still_reach_total_cap(self):
        requests = [{**REQUEST, "id": i} for i in range(5)]
        rounds = [{**ANSWERED, "id": i} for i in range(5)]
        findings = [{"user": USER, "pull_request_review_id": i, "body": "![P1 Badge]"} for i in range(5)]
        result = classify(comments=requests, reviews=rounds, inline=findings)
        self.assertEqual(result["chargeableRounds"], 0)
        self.assertEqual(result["requestsRemaining"], 0)
        self.assertFalse(result["canRequest"])

    def test_clean_comment_result_completes_and_settles(self):
        value = comment_observation()
        self.assertEqual((value["state"], value["chargeableRounds"]), ("submitted", 1))
        self.assertIsNotNone(lib.completion_summary(value))
        self.assertEqual(cli.check_review_flow(value)["status"], "pass")
        self.assertEqual(lib.poll(lambda deadline: value, **Clock().options())["state"], "settled")

    def test_result_comments_require_bot_format_commit_and_trusted_request(self):
        for altered in ({**COMMENT_REVIEW, "user": {"login": "human"}}, {**COMMENT_REVIEW, "body": "No issues found"},
                        {**COMMENT_REVIEW, "body": COMMENT_REVIEW["body"].replace("abcdef0123", "xyz")},
                        {**COMMENT_REVIEW, "created_at": "2026-09-11T10:00:00Z"}):
            self.assertEqual(comment_observation([REQUEST, altered, SUMMARY])["state"], "requested")
        self.assertEqual(comment_observation([{**REQUEST, "author_association": "CONTRIBUTOR"}, COMMENT_REVIEW, SUMMARY])["state"], "unknown")
        self.assertEqual(comment_observation([COMMENT_REVIEW, SUMMARY])["state"], "unknown")
        without_summary = comment_observation([REQUEST, COMMENT_REVIEW])
        self.assertEqual(without_summary["state"], "submitted")
        self.assertIsNone(lib.completion_summary(without_summary))

    def test_result_comments_are_invalidated_and_not_double_charged(self):
        newer = {**REQUEST, "id": 91, "created_at": "2026-09-11T12:30:00Z"}
        self.assertEqual(comment_observation([REQUEST, COMMENT_REVIEW, SUMMARY, newer])["state"], "requested")
        self.assertEqual(classify(head="9999999999999999", comments=[REQUEST, COMMENT_REVIEW, SUMMARY])["state"], "stale")
        formal = {**ANSWERED, "submitted_at": "2026-09-11T11:59:58Z"}
        result = comment_observation(reviews=[formal])
        self.assertEqual((result["currentReview"]["id"], result["chargeableRounds"]), (formal["id"], 1))
        repeated = comment_observation([REQUEST, COMMENT_REVIEW, {**COMMENT_REVIEW, "id": 92}, SUMMARY])
        self.assertEqual(repeated["chargeableRounds"], 1)

    def test_usage_refusal_voids_only_the_live_bot_round(self):
        refused = classify(comments=[REQUEST, LIMIT_REPLY])
        self.assertEqual((refused["state"], refused["chargeableRounds"], refused["canRequest"]), ("refused", 0, True))
        for reply in ({**LIMIT_REPLY, "user": {"login": "human"}}, {**LIMIT_REPLY, "created_at": "2026-09-11T10:30:00Z"}):
            self.assertEqual(classify(comments=[REQUEST, reply])["state"], "requested")
        self.assertEqual(classify(head=HEAD, comments=[REQUEST, LIMIT_REPLY], reviews=[ANSWERED])["state"], "submitted")
        self.assertEqual(classify(comments=[REQUEST, LIMIT_REPLY, {**REQUEST, "id": 12, "created_at": ANSWERED["submitted_at"]}])["state"], "requested")
        self.assertEqual(cli.check_review_flow(gate_base(state="refused"))["status"], "pass")


class SnapshotTests(unittest.TestCase):
    def test_paginated_reviews_replies_and_thread_metadata(self):
        calls = []
        def api(args, deadline=math.inf):
            calls.append(args)
            if args[1] == "graphql":
                return graph("head", [thread(comments={"nodes": [{"databaseId": 3}]})])
            path = args[-1]
            if "/reviews?" in path:
                return [[], [REVIEW]]
            if "/pulls/1/comments?" in path:
                return [[{"id": 3, "user": USER, "body": "Finding"}], [{"id": 4, "user": {"login": "human"}, "in_reply_to_id": 3, "body": "Fixed"}]]
            if "/reactions?" in path:
                return [[{"user": USER, "content": "eyes"}]]
            return review_api(head="head", comments=[REQUEST])(args, deadline)
        result = lib.snapshot("owner/repo", 1, api=api, include_threads=True)
        self.assertEqual((len(result["reviews"]), len(result["inlineComments"])), (1, 2))
        self.assertTrue(result["inlineComments"][1]["thread"]["isResolved"])
        self.assertEqual(result["state"], "acknowledged")
        self.assertNotIn("statuses", result)
        self.assertFalse(any("POST" in args for args in calls))

    def test_head_movement_during_collection(self):
        reads = 0
        def api(args, deadline=math.inf):
            nonlocal reads
            if args[-1].endswith("/pulls/1"):
                reads += 1
                return {"head": {"sha": "old" if reads == 1 else "head"}}
            return review_api(reviews=[REVIEW])(args, deadline)
        self.assertEqual(lib.snapshot("owner/repo", 1, api=api)["state"], "unknown")

    def test_threads_and_checks_bind_to_final_head_including_a_b_a(self):
        for heads in (["head", "head", "moved"], ["a", "b", "a"]):
            reads = iter(heads)
            def api(args, deadline=math.inf):
                if args[-1].endswith("/pulls/1"):
                    return {"head": {"sha": next(reads)}}
                return gate_api()(args, deadline)
            self.assertEqual(lib.snapshot("owner/repo", 1, api=api, include_checks=True)["state"], "unknown")
        def moved_threads(args, deadline=math.inf):
            if args[1] == "graphql":
                return graph("old", []) + graph(HEAD, [])
            return gate_api()(args, deadline)
        self.assertEqual(lib.snapshot("owner/repo", 1, api=moved_threads, include_threads=True)["state"], "unknown")

    def test_checks_are_paginated_all_runs_and_precede_final_head_metadata(self):
        order, check_paths, reads = [], [], 0
        def api(args, deadline=math.inf):
            nonlocal reads
            path = args[-1]
            if path.endswith("/pulls/1"):
                reads += 1
                order.append("pr")
                return {**gate_api()(args), "state": "closed" if reads == 3 else "open"}
            if "/statuses?" in path:
                order.append("statuses")
            if "/check-runs?" in path:
                order.append("check-runs")
                check_paths.append(path)
                return [{"check_runs": [{"id": 1}]}, {"check_runs": [{"id": 2}]}]
            return gate_api()(args, deadline)
        result = lib.snapshot("owner/repo", 1, api=api, include_checks=True)
        self.assertEqual(result["prState"], "closed")
        self.assertEqual(result["checkRuns"], [{"id": 1}, {"id": 2}])
        self.assertIn("filter=all&per_page=100", check_paths[0])
        self.assertEqual(order[-1], "pr")

    def test_graphql_errors_fail_the_observation(self):
        def api(args, deadline=math.inf):
            return [{"errors": [{"message": "denied"}]}] if args[1] == "graphql" else gate_api()(args, deadline)
        with self.assertRaisesRegex(RuntimeError, "denied"):
            lib.snapshot("owner/repo", 1, api=api, include_threads=True)


class PollTests(unittest.TestCase):
    def test_summary_second_precision_and_invalid_timestamps(self):
        fractional = {**SUMMARY, "updated_at": "2026-09-11T12:00:00Z", "body": SUMMARY["body"].replace("12:00:00Z", "12:00:00.217327Z")}
        self.assertIsNotNone(lib.completion_summary(comment_observation([REQUEST, COMMENT_REVIEW, fractional])))
        future = {**fractional, "body": fractional["body"].replace("00.217327Z", "01.217327Z")}
        self.assertIsNone(lib.completion_summary(comment_observation([REQUEST, COMMENT_REVIEW, future])))
        self.assertIsNone(lib.completion_summary(observation(comments=[{**SUMMARY, "updated_at": "invalid"}])))

    def test_stale_running_malformed_human_summaries_do_not_qualify(self):
        for altered in ({**SUMMARY, "user": {"login": "human"}},
                        *[{**SUMMARY, "body": SUMMARY["body"].replace(old, new)} for old, new in
                          (("abcdef0", "1234567"), ("Completed", "Running"), ("12:00:00Z", "09:00:00Z"))]):
            self.assertIsNone(lib.completion_summary(observation(comments=[altered])))

    def test_summary_must_follow_latest_inline_edit_for_both_carriers(self):
        finding = {"user": USER, "pull_request_review_id": REVIEW["id"], "updated_at": "2026-09-11T12:00:02Z"}
        for value in (observation(), comment_observation()):
            self.assertIsNone(lib.completion_summary({**value, "inlineComments": [finding]}))

    def test_refusal_stops_poll_immediately_or_after_waiting(self):
        for refused_at in (0, 10):
            clock, events = Clock(), []
            def read(deadline):
                return classify(comments=[REQUEST, LIMIT_REPLY] if clock.now() >= refused_at else [REQUEST])
            result = lib.poll(read, **clock.options(), on_progress=events.append)
            self.assertEqual(clock.now(), refused_at)
            self.assertEqual(result["state"], "refused")
            self.assertEqual(result["nextAction"], "gate")
            self.assertFalse(result["timedOut"])
            self.assertFalse(result["observationStable"])
            self.assertEqual(events[-1]["phase"], "refused")

    def test_submission_without_summary_times_out(self):
        result = lib.poll(lambda deadline: observation(comments=[]), **Clock().options())
        self.assertTrue(result["timedOut"])
        self.assertFalse(result["observationStable"])

    def test_late_findings_and_edited_bodies_restart_window(self):
        for edit in (False, True):
            clock = Clock()
            def read(deadline):
                comments = [{"id": 5, "user": USER, "body": "edited" if clock.now() >= 10 else "original"}]
                return observation(inlineComments=comments if edit or clock.now() >= 10 else [])
            result = lib.poll(read, **clock.options())
            self.assertEqual(clock.now(), 30)
            self.assertEqual(result["state"], "settled")
            self.assertEqual(result["inlineComments"][0]["body"], "edited")

    def test_new_head_or_request_restarts_window(self):
        for change in ({"head": "abcdef0999999999"}, {"request": {"id": 10, "createdAt": REQUEST["created_at"]}}):
            clock = Clock()
            lib.poll(lambda deadline: observation(**(change if clock.now() >= 10 else {})), **clock.options())
            self.assertEqual(clock.now(), 30)

    def test_stable_empty_observation_is_never_labelled_clean_or_approved(self):
        result = lib.poll(lambda deadline: observation(), **Clock().options())
        self.assertEqual(result["state"], "settled")
        self.assertTrue(result["observationStable"])
        self.assertNotIn("clean", result)
        self.assertNotIn("approved", result)

    def test_timeout_and_deadline_errors_keep_observation_unconfirmed(self):
        clock = Clock()
        result = lib.poll(lambda deadline: observation(), **{**clock.options(), "timeout_ms": 15})
        self.assertEqual(clock.now(), 15)
        self.assertTrue(result["timedOut"])
        self.assertFalse(result["observationStable"])
        def fail(deadline):
            raise RuntimeError("403")
        with self.assertRaisesRegex(RuntimeError, "403"):
            lib.poll(fail)
        def exceed(deadline):
            clock.time = deadline
            raise RuntimeError("deadline")
        self.assertTrue(lib.poll(exceed, **clock.options())["timedOut"])

    def test_default_settle_window_finishes_before_poll_interval(self):
        clock = Clock()
        result = lib.poll(lambda deadline: comment_observation(), now=clock.now, wait=clock.wait)
        self.assertEqual(result["state"], "settled")
        self.assertEqual(clock.now(), 5000)

    def test_progress_diagnoses_unrecognized_result_and_reports_changes(self):
        clock, events = Clock(), []
        def read(deadline):
            return comment_observation([REQUEST, {**COMMENT_REVIEW, "body": "new unsupported format"}, SUMMARY]) if clock.now() < 10 else comment_observation()
        result = lib.poll(read, **clock.options(), on_progress=events.append)
        self.assertEqual([event["phase"] for event in events], ["unrecognized-result", "settling", "settled"])
        self.assertEqual(result["state"], "settled")
        result = lib.poll(lambda deadline: comment_observation([REQUEST, SUMMARY]), **Clock().options())
        self.assertIn("diagnostic", result)


class RequestTests(unittest.TestCase):
    def test_posts_exactly_one_comment_with_updated_budget(self):
        posted = []
        result = lib.request_review("owner/repo", 1, **Clock().options(), api=review_api(comments=[REQUEST, SUMMARY], reviews=[ANSWERED], posted=posted))
        self.assertFalse(result["rejected"])
        self.assertEqual((result["requestCount"], result["chargeableRounds"], result["requestsRemaining"]), (2, 1, 2))
        self.assertTrue(result["canRequest"])
        self.assertEqual(result["posted"]["id"], 7)
        self.assertEqual(posted, [["api", "-X", "POST", "repos/owner/repo/issues/1/comments", "-f", "body=@codex review"]])

    def test_fresh_and_refused_rounds_can_request_without_charge(self):
        for comments, count in (([], 1), ([REQUEST, LIMIT_REPLY], 2)):
            posted = []
            result = lib.request_review("owner/repo", 1, api=review_api(comments=comments, posted=posted))
            self.assertFalse(result["rejected"])
            self.assertEqual((result["requestCount"], result["chargeableRounds"]), (count, 0))
            self.assertEqual(len(posted), 1)

    def test_total_cap_includes_refused_requests(self):
        for count in (4, 5, 6):
            posted = []
            requests = [{**REQUEST, "id": i} for i in range(count)]
            result = lib.request_review("owner/repo", 1, api=review_api(comments=[*requests, LIMIT_REPLY], posted=posted))
            self.assertEqual(result["rejected"], count >= 5)
            self.assertEqual(len(posted), int(count < 5))
            self.assertEqual(result["chargeableRounds"], 0)
            self.assertEqual(result["requestsRemaining"], 0)
            self.assertFalse(result["canRequest"])
            if count >= 5:
                self.assertIn("Total request limit", result["reason"])

    def test_in_flight_cap_and_closed_pr_reject_without_posting(self):
        for setup, reason in (({"comments": [REQUEST]}, "in flight"),
                              ({"comments": [REQUEST], "reviews": [{**ANSWERED, "id": i} for i in range(3)]}, "limit"),
                              ({"pr_state": "closed"}, "not open")):
            posted = []
            result = lib.request_review("owner/repo", 1, api=review_api(**setup, posted=posted))
            self.assertTrue(result["rejected"])
            self.assertIn(reason, result["reason"])
            self.assertEqual(posted, [])

    def test_request_change_during_evaluation_aborts(self):
        posted, reads = [], 0
        def api(args, deadline=math.inf):
            nonlocal reads
            if "/issues/1/comments?" in args[-1]:
                reads += 1
            comments = [REQUEST, SUMMARY] + ([{**REQUEST, "id": 9, "created_at": "2026-09-11T12:30:00Z"}] if reads > 1 else [])
            return review_api(comments=comments, reviews=[ANSWERED], posted=posted)(args, deadline)
        result = lib.request_review("owner/repo", 1, **Clock().options(), api=api)
        self.assertTrue(result["rejected"])
        self.assertIn("changed during evaluation", result["reason"])
        self.assertEqual(posted, [])

    def test_recheck_closed_pr_before_posting(self):
        posted, reads = [], 0
        def api(args, deadline=math.inf):
            nonlocal reads
            if args[-1].endswith("/pulls/1"):
                reads += 1
            return review_api(pr_state="closed" if reads >= 4 else "open", posted=posted)(args, deadline)
        result = lib.request_review("owner/repo", 1, api=api)
        self.assertTrue(result["rejected"])
        self.assertIn("no longer open", result["reason"])
        self.assertEqual(posted, [])

    def test_recheck_changed_head_before_initial_post(self):
        reads, posted = 0, []
        def api(args, deadline=math.inf):
            nonlocal reads
            if args[-1].endswith("/pulls/1"):
                reads += 1
            return review_api(head="moved" if reads >= 3 else HEAD, posted=posted)(args, deadline)
        self.assertTrue(lib.request_review("owner/repo", 1, api=api)["rejected"])
        self.assertEqual(posted, [])

    def test_completion_without_summary_cannot_start_another_round(self):
        for reviews in ([], [ANSWERED]):
            posted = []
            result = lib.request_review("owner/repo", 1, **Clock().options(), api=review_api(comments=[REQUEST, COMMENT_REVIEW], reviews=reviews, posted=posted))
            self.assertTrue(result["rejected"])
            self.assertIn("completion is unconfirmed", result["reason"])
            self.assertEqual(posted, [])

    def test_late_formal_result_resets_window_and_charges_once(self):
        clock, posted = Clock(), []
        formal = {**ANSWERED, "submitted_at": "2026-09-11T12:00:01Z"}
        updated = {**SUMMARY, "updated_at": "2026-09-11T12:00:02Z", "body": SUMMARY["body"].replace("12:00:00Z", "12:00:02Z")}
        def api(args, deadline=math.inf):
            if "POST" in args:
                self.assertGreaterEqual(clock.now(), 40)
            return review_api(comments=[REQUEST, COMMENT_REVIEW, updated if clock.now() >= 20 else SUMMARY],
                              reviews=[formal] if clock.now() >= 10 else [], posted=posted)(args, deadline)
        result = lib.request_review("owner/repo", 1, **clock.options(), api=api)
        self.assertFalse(result["rejected"])
        self.assertEqual((result["chargeableRounds"], len(posted)), (1, 1))

    def test_previous_commit_settles_after_head_advances_with_either_abbreviation(self):
        for result_commit, summary_commit in (("abcdef0", "abcdef0123"), ("abcdef0123", "abcdef0")):
            for head in (HEAD, "9999999999999999"):
                posted = []
                comments = [REQUEST, {**COMMENT_REVIEW, "body": COMMENT_REVIEW["body"].replace("abcdef0123", result_commit)},
                            {**SUMMARY, "body": SUMMARY["body"].replace("abcdef0", summary_commit)}]
                result = lib.request_review("owner/repo", 1, **Clock().options(), api=review_api(head=head, comments=comments, posted=posted))
                self.assertFalse(result["rejected"])
                self.assertEqual(len(posted), 1)

    def test_edited_finding_can_exhaust_budget_before_post(self):
        clock, posted = Clock(), []
        requests = [{**REQUEST, "id": 11, "created_at": "2026-09-11T09:00:00Z"},
                    {**REQUEST, "id": 12, "created_at": "2026-09-11T10:00:00Z"}, REQUEST]
        reviews = [{**ANSWERED, "id": 11 + i, "submitted_at": timestamp} for i, timestamp in enumerate(
            ("2026-09-11T09:30:00Z", "2026-09-11T10:30:00Z", "2026-09-11T11:59:59Z"))]
        def api(args, deadline=math.inf):
            if "/pulls/1/comments?" in args[-1]:
                return [[{"id": 100, "user": USER, "pull_request_review_id": 13,
                          "body": "![P1 Badge]" if clock.now() < 10 else "![P2 Badge]", "updated_at": "2026-09-11T12:00:00Z"}]]
            return review_api(comments=requests + [SUMMARY], reviews=reviews, posted=posted)(args, deadline)
        result = lib.request_review("owner/repo", 1, **clock.options(), api=api)
        self.assertTrue(result["rejected"])
        self.assertIn("limit", result["reason"])
        self.assertEqual(result["chargeableRounds"], 3)
        self.assertEqual(posted, [])

    def test_changing_round_or_head_prevents_post(self):
        for move_head in (False, True):
            clock, posted = Clock(), []
            def api(args, deadline=math.inf):
                return review_api(head="9999999999999999" if move_head and clock.now() >= 10 else HEAD,
                                  comments=[REQUEST, {**COMMENT_REVIEW, "body": COMMENT_REVIEW["body"] + "\n" + str(clock.now())}, SUMMARY],
                                  posted=posted)(args, deadline)
            self.assertTrue(lib.request_review("owner/repo", 1, **clock.options(), api=api)["rejected"])
            self.assertEqual(posted, [])


class GateTests(unittest.TestCase):
    def test_policy_atoms(self):
        cases = [
            (cli.check_pr_open, {}, "pass"), (cli.check_pr_open, {"draft": True}, "pending"),
            (cli.check_pr_open, {"prState": "closed"}, "blocked"),
            (cli.check_mergeable, {"mergeable": None}, "pending"), (cli.check_mergeable, {"mergeable": False}, "blocked"),
            (cli.check_mergeable, {"mergeableState": "blocked"}, "blocked"), (cli.check_mergeable, {"mergeableState": "draft"}, "pending"),
            (cli.check_review_initiated, {"requestCount": 0}, "blocked"), (cli.check_review_flow, {}, "pass"),
            (cli.check_review_flow, {"comments": []}, "pending"), (cli.check_review_flow, {"state": "requested"}, "pending"),
            (cli.check_review_flow, {"state": "requested", "canRequest": False}, "pass"),
            (cli.check_review_flow, {"state": "stale", "canRequest": False}, "pass"),
            (cli.check_review_flow, {"state": "unknown"}, "pending"),
            (cli.check_threads_resolved, {"threads": [thread(False, isOutdated=True)]}, "blocked"),
            (cli.check_threads_resolved, {"threads": None}, "blocked"),
            (cli.check_verification, {"statuses": None}, "blocked"), (cli.check_verification, {"checkRuns": None}, "blocked"),
            # Nothing published yet: the run may still be starting, so wait for it.
            (cli.check_verification, {"checkRuns": []}, "pending"),
            (cli.check_verification, {"statuses": [{"context": "other", "state": "pending", "id": 1}]}, "pending"),
            (cli.check_verification, {"checkRuns": [verification_run("in_progress")]}, "pending"),
            (cli.check_verification, {"checkRuns": [verification_run("action_required")]}, "blocked"),
            (cli.check_verification, {"checkRuns": [{"id": 6, "name": "ci", "status": "completed", "conclusion": "success"}]}, "pending"),
        ]
        for check, changes, expected in cases:
            with self.subTest(check=check.__name__, changes=changes):
                self.assertEqual(check(gate_base(**changes))["status"], expected)

    def test_failures_beat_pending_and_a_newer_run_supersedes_the_one_it_replaced(self):
        statuses = [{"context": "other", "state": "pending", "id": 1}, {"context": "another", "state": "failure", "id": 2}]
        self.assertEqual(cli.check_verification(gate_base(statuses=statuses))["status"], "blocked")
        ci = lambda identifier, conclusion: {"id": identifier, "name": "ci", "status": "completed",
                                             "conclusion": conclusion, "app": {"id": 1}, "check_suite": {"id": identifier}}
        # `cancel-in-progress` cancels the run a newer one replaces: the replacement decides.
        runs = [verification_run(), ci(2, "cancelled"), ci(3, "success")]
        self.assertEqual(cli.check_verification(gate_base(checkRuns=runs))["status"], "pass")
        # The newest run still decides, so a newer failure is never masked by an older success.
        runs = [verification_run(), ci(3, "success"), ci(4, "failure")]
        self.assertEqual(cli.check_verification(gate_base(checkRuns=runs))["status"], "blocked")
        # Different apps publish checks under the same name and are evaluated apart.
        runs = [verification_run(), ci(3, "failure"),
                {"id": 4, "name": "ci", "status": "completed", "conclusion": "success", "app": {"id": 2}}]
        self.assertEqual(cli.check_verification(gate_base(checkRuns=runs))["status"], "blocked")
        for conclusion in ("neutral", "skipped", "success"):
            runs = [verification_run(), {"id": 7, "name": "ci", "status": "completed", "conclusion": conclusion, "app": {"id": 1}}]
            self.assertEqual(cli.check_verification(gate_base(checkRuns=runs))["status"], "pass")

    def test_verification_requires_evidence_for_the_current_head_and_base(self):
        for summary in (None, "Desktop verification passed", "scope-v2:docs:" + HEAD + ":" + BASE,
                        "scope-v2:scoped:" + "a" * 40 + ":" + BASE, "scope-v2:scoped:" + HEAD + ":" + "c" * 40,
                        "scope-v1:scoped:" + BASE):
            run = verification_run(output={"summary": summary})
            self.assertEqual(cli.check_verification(gate_base(checkRuns=[run]))["status"], "blocked")
        self.assertEqual(cli.check_verification(gate_base(verificationSnapshotStable=False))["status"], "blocked")
        self.assertEqual(cli.check_verification(gate_base(baseSha=None))["status"], "blocked")
        for profile in ("full", "scoped"):
            run = verification_run(output={"summary": "scope-v2:" + profile + ":" + HEAD + ":" + BASE})
            self.assertEqual(cli.check_verification(gate_base(checkRuns=[run]))["status"], "pass")

    def test_newest_verification_run_decides(self):
        stale = verification_run(id=1, output={"summary": "scope-v2:scoped:" + HEAD + ":" + "c" * 40})
        current = verification_run(id=2)
        self.assertEqual(cli.check_verification(gate_base(checkRuns=[stale, current]))["status"], "pass")
        # A newer stale run must not be masked by an older success.
        masked = verification_run(id=3, output={"summary": "scope-v2:scoped:" + HEAD + ":" + "c" * 40})
        self.assertEqual(cli.check_verification(gate_base(checkRuns=[stale, current, masked]))["status"], "blocked")

    def test_latest_commit_status_per_context_wins(self):
        statuses = [{"context": "other", "state": "success", "id": 2}, {"context": "other", "state": "failure", "id": 1}]
        self.assertEqual(cli.check_verification(gate_base(statuses=statuses))["status"], "pass")

    def test_aggregation_and_check_selection(self):
        for changes, status, code in (({}, "ready", 0), ({"draft": True}, "pending", 2), ({"draft": True, "requestCount": 0}, "blocked", 1)):
            result = cli.run_gate(gate_base(**changes))
            self.assertEqual((result["status"], result["exitCode"]), (status, code))
        self.assertEqual(list(cli.select_checks(only="checkPrOpen")), ["checkPrOpen"])
        self.assertEqual(len(cli.select_checks(skip="checkVerification")), len(cli.GATE_CHECKS) - 1)
        for options in ({"only": "checkNope"}, {"skip": "checkNope"}, {"only": "checkPrOpen,checkPrOpen"}, {"skip": ",".join(cli.GATE_CHECKS)}):
            with self.assertRaises(ValueError):
                cli.select_checks(**options)

    def test_gate_rejects_base_changes_during_snapshot_even_when_base_returns(self):
        underlying = gate_api()
        reads = 0

        def api(args, deadline=math.inf):
            nonlocal reads
            value = underlying(args, deadline)
            if args[-1].endswith("/pulls/1"):
                reads += 1
                return {**value, "base": {"sha": "a" * 40 if reads == 2 else BASE}}
            return value

        result = cli.gate("owner/repo", 1, api=api)
        self.assertEqual(result["status"], "blocked")

    def test_gate_reads_full_snapshot(self):
        ready = cli.gate("owner/repo", 1, api=gate_api())
        self.assertEqual((ready["status"], ready["exitCode"], len(ready["checks"])), ("ready", 0, 6))
        unresolved = cli.gate("owner/repo", 1, api=gate_api(threads=[thread(False)]))
        self.assertEqual(unresolved["status"], "blocked")
        self.assertIn("Unresolved", next(check for check in unresolved["checks"] if check["check"] == "checkThreadsResolved")["detail"])
        skipped = cli.gate("owner/repo", 1, api=gate_api(), skip="checkThreadsResolved")
        self.assertNotIn("checkThreadsResolved", [check["check"] for check in skipped["checks"]])
        self.assertEqual(cli.gate("owner/repo", 1, api=gate_api(verification="in_progress"))["status"], "pending")


class MergeTests(unittest.TestCase):
    def test_blocks_or_dry_runs_without_executing_then_confirms_merge(self):
        calls = []
        def api(args, deadline=math.inf):
            if args[-1].endswith("/pulls/1") and calls:
                return {"head": {"sha": HEAD}, "state": "closed", "merged": True, "merge_commit_sha": "m1"}
            return gate_api()(args, deadline)
        blocked = cli.merge("owner/repo", 1, api=gate_api(threads=[thread(False)]), run=calls.append)
        self.assertEqual((blocked["status"], blocked["merged"], calls), ("blocked", False, []))
        dry = cli.merge("owner/repo", 1, api=gate_api(), run=calls.append, check=True)
        self.assertEqual((dry["status"], dry["merged"], calls), ("ready", False, []))
        merged = cli.merge("owner/repo", 1, api=api, run=calls.append, settle_ms=0)
        self.assertEqual((merged["status"], merged["mergeCommitSha"]), ("merged", "m1"))
        self.assertEqual(calls, [["pr", "merge", "1", "--repo", "owner/repo", "--squash", "--match-head-commit", HEAD]])

    def test_exec_merge_confirms_same_head_and_requested_method(self):
        for method in ("squash", "merge", "rebase"):
            calls = []
            result = lib.exec_merge("owner/repo", 1, "head", api=lambda args: {"merged": True, "state": "closed", "head": {"sha": "head"}, "merge_commit_sha": "m1"}, run=calls.append, method=method)
            self.assertEqual(result["mergeCommitSha"], "m1")
            self.assertIn("--" + method, calls[0])
        for response in ({"merged": False, "state": "open", "head": {"sha": "head"}}, {"merged": True, "state": "closed", "head": {"sha": "moved"}}):
            with self.assertRaisesRegex(RuntimeError, "could not be confirmed"):
                lib.exec_merge("owner/repo", 1, "head", api=lambda args: response, run=lambda args: None)

    def test_late_findings_require_another_settle_window(self):
        clock, calls, reads = Clock(), [], 0
        finding = {"id": 30, "user": USER, "pull_request_review_id": 1, "body": "late finding", "created_at": "2026-09-11T12:00:01Z", "updated_at": "2026-09-11T12:00:01Z"}
        def api(args, deadline=math.inf):
            nonlocal reads
            if args[-1].endswith("/pulls/1") and calls:
                return {"head": {"sha": HEAD}, "state": "closed", "merged": True, "merge_commit_sha": "m1"}
            if "/pulls/1/comments?" in args[-1]:
                reads += 1
                return [[finding]] if reads >= 2 else [[]]
            return gate_api()(args, deadline)
        result = cli.merge("owner/repo", 1, api=api, run=calls.append, wait=clock.wait, now=clock.now)
        self.assertEqual(result["status"], "merged")
        self.assertGreaterEqual(clock.now(), 10000)
        self.assertEqual(len(calls), 1)

    def test_new_unresolved_thread_blocks_after_initial_ready_snapshot(self):
        clock, calls = Clock(), []
        def api(args, deadline=math.inf):
            return gate_api(threads=[thread(clock.now() == 0)])(args, deadline)
        result = cli.merge("owner/repo", 1, api=api, run=calls.append, wait=clock.wait, now=clock.now)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(calls, [])

    def test_refused_fallback_rechecks_immediately_and_still_blocks_new_failure(self):
        for fail_second in (False, True):
            calls, pr_reads = [], 0
            def api(args, deadline=math.inf):
                nonlocal pr_reads
                path = args[-1]
                if path.endswith("/pulls/1"):
                    pr_reads += 1
                    if calls:
                        return {"head": {"sha": HEAD}, "state": "closed", "merged": True, "merge_commit_sha": "m1"}
                if "/reviews?" in path:
                    return [[]]
                if "/issues/1/comments?" in path:
                    return [[REQUEST, LIMIT_REPLY]]
                return gate_api(verification="failure" if fail_second and pr_reads >= 4 else "success")(args, deadline)
            result = cli.merge("owner/repo", 1, api=api, run=calls.append, wait=lambda ms: self.fail("fallback must not wait"))
            self.assertEqual(result["status"], "blocked" if fail_second else "merged")
            self.assertEqual(len(calls), 0 if fail_second else 1)


class CliTests(unittest.TestCase):
    def test_invalid_options_fail_before_api_access(self):
        cases = [[], ["status", "0"], ["poll", "1", "--interval", "0"], ["poll", "1", "--timeout", "nan"],
                 ["poll", "1", "--settle", "0"], ["status", "1", "--wat", "x"], ["status", "1", "--repo"],
                 ["status", "1", "--repo", "a/b", "--repo", "c/d"], ["status", "1", "--repo", "bad"],
                 ["merge", "1", "--only", "checkPrOpen"], ["merge", "1", "--merge", "--rebase"],
                 ["request", "1", "--check"], ["request", "1", "--skip", "checkVerification"], ["merge", "1", "--check", "--check"]]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(ValueError):
                cli.main(args, api=lambda *args: self.fail("invalid options must not access GitHub"))

    def test_json_commands_exit_codes_and_read_modes(self):
        for command in ("status", "comments", "snapshot"):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = cli.main([command, "1", "--repo", "owner/repo"], api=gate_api())
            result = json.loads(output.getvalue())
            self.assertEqual(code, 0)
            self.assertEqual("threads" in result, command != "status")
            self.assertEqual("statuses" in result, command == "snapshot")
        for args, api, expected in ((["gate", "1"], gate_api(), 0), (["gate", "1"], gate_api(threads=[thread(False)]), 1),
                                    (["gate", "1"], gate_api(verification="in_progress"), 2), (["request", "1"], review_api(comments=[REQUEST]), 3)):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                code = cli.main(args + ["--repo", "owner/repo"], api=api)
            self.assertEqual(code, expected)
            self.assertIsInstance(json.loads(output.getvalue()), dict)

    def test_poll_progress_goes_to_stderr_and_timeout_is_exit_two(self):
        clock = Clock()
        real_poll = lib.poll
        def timed_poll(read, **options):
            return real_poll(read, **{**options, **clock.options()})
        api = gate_api()
        def no_result(args, deadline=math.inf):
            return [[]] if "/reviews?" in args[-1] else api(args, deadline)
        with patch.object(cli, "poll", timed_poll), contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as errors:
            code = cli.main(["poll", "1", "--repo", "owner/repo"], api=no_result)
        self.assertEqual(code, 2)
        self.assertTrue(json.loads(output.getvalue())["timedOut"])
        events = [json.loads(line) for line in errors.getvalue().splitlines()]
        self.assertEqual(events[0]["phase"], "unrecognized-result")
        self.assertEqual(events[-1]["phase"], "timed-out")

    def test_poll_refusal_exits_zero_with_gate_next_action(self):
        base = review_api(comments=[REQUEST, LIMIT_REPLY])
        def api(args, deadline=math.inf):
            return graph() if args[1] == "graphql" else base(args, deadline)
        with contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as errors:
            code = cli.main(["poll", "1", "--repo", "owner/repo"], api=api)
        self.assertEqual(code, 0)
        result = json.loads(output.getvalue())
        self.assertEqual((result["state"], result["nextAction"]), ("refused", "gate"))
        self.assertFalse(result["timedOut"])
        self.assertEqual(json.loads(errors.getvalue())["phase"], "refused")

    def test_merge_method_and_dry_run_dispatch(self):
        for flag, method in (("--merge", "merge"), ("--rebase", "rebase"), (None, "squash")):
            with patch.object(cli, "merge", return_value={"exitCode": 0}) as merge, contextlib.redirect_stdout(io.StringIO()):
                cli.main(["merge", "1", "--repo", "owner/repo", "--check"] + ([flag] if flag else []))
            self.assertEqual(merge.call_args.kwargs["method"], method)
            self.assertTrue(merge.call_args.kwargs["check"])

    def test_subprocess_gh_adapter_and_real_cli_without_network(self):
        with tempfile.TemporaryDirectory(prefix="pr-gate-test-") as directory:
            fake = Path(directory) / "gh"
            log = Path(directory) / "calls.jsonl"
            fake.write_text("#!" + sys.executable + "\n" + '''import json, os, sys
args = sys.argv[1:]
with open(os.environ['PR_GATE_TEST_LOG'], 'a') as file:
    file.write(json.dumps(args) + '\\n')
if args[:2] == ['repo', 'view']:
    result = {'nameWithOwner': 'owner/repo'}
elif args[-1].endswith('/pulls/1'):
    result = {'head': {'sha': 'head'}, 'state': 'open', 'html_url': 'url'}
elif 'POST' in args:
    result = {'id': 7, 'html_url': 'posted', 'created_at': '2026-09-11T13:00:00Z'}
else:
    result = [[]]
print(json.dumps(result))
''', encoding="utf-8")
            fake.chmod(0o755)
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ.get("PATH", ""), "PR_GATE_TEST_LOG": str(log)}
            command = [sys.executable, "-B", str(SCRIPTS / "pr-gate.py")]
            result = subprocess.run(command + ["status", "1"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["head"], "head")
            self.assertEqual(result.stderr, "")
            result = subprocess.run(command + ["request", "1", "--repo", "owner/repo"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["posted"]["id"], 7)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(sum("POST" in args for args in calls), 1)
            result = subprocess.run(command + ["merge", "1", "--only", "checkPrOpen"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertEqual(json.loads(result.stderr)["state"], "error")
            self.assertEqual(len(log.read_text().splitlines()), len(calls))
            result = subprocess.run(command + ["--help"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertIn("python3 scripts/pr-gate.py", result.stdout)

    def test_gh_errors_and_deadlines_fail_closed(self):
        with patch.object(lib, "now_ms", return_value=100), patch.object(lib.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "deadline"):
                lib.gh(["api", "x"], deadline=100)
            run.assert_not_called()
            run.return_value = subprocess.CompletedProcess([], 0, '{"ok": true}', '')
            self.assertEqual(lib.gh(["api", "x"], deadline=600), {"ok": True})
            self.assertEqual(run.call_args.kwargs["timeout"], 0.5)
            self.assertEqual(run.call_args.args[0], ["gh", "api", "x"])
            for status, stdout, stderr in ((1, '', '403'), (0, '{"errors": ["denied"]}', '')):
                run.return_value = subprocess.CompletedProcess([], status, stdout, stderr)
                with self.assertRaises(RuntimeError):
                    lib.gh(["api", "x"])
            run.side_effect = subprocess.TimeoutExpired("gh", 1)
            with self.assertRaises(RuntimeError):
                lib.gh(["api", "x"])


if __name__ == "__main__":
    unittest.main()
