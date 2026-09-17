#!/usr/bin/env python3
"""PR gate policy and JSON command-line interface."""

import json
import math
import re
import sys

from pr_gate_lib import (
    completion_summary, exec_merge, gh, gh_run, now_ms, poll,
    request_review, review_fingerprint, sleep_ms, snapshot,
)


VERIFICATION_CHECK = "verify"
VERIFICATION_PROOF = re.compile(r"scope-v2:(full|scoped):([a-f0-9]{40}):([a-f0-9]{40})")
REVIEW_SETTLE_MS = 5000


def passed(detail):
    return {"status": "pass", "detail": detail}


def pending(detail):
    return {"status": "pending", "detail": detail}


def blocked(detail):
    return {"status": "blocked", "detail": detail}


def check_pr_open(value):
    if value.get("prState") != "open":
        return blocked("PR is {}; only open PRs can merge.".format(value.get("prState")))
    if value.get("draft"):
        return pending("PR is a draft.")
    return passed("PR is open.")


def check_mergeable(value):
    if value.get("mergeable") is None:
        return pending("GitHub is calculating mergeability.")
    if value["mergeable"] is not True:
        return blocked("PR has merge conflicts.")
    state = value.get("mergeableState")
    if state == "unknown":
        return pending("Mergeability state is unknown.")
    if state == "draft":
        return pending("PR is a draft.")
    if state not in {"clean", "has_hooks", "unstable"}:
        return blocked("PR mergeability state is {}.".format(state))
    return passed("Mergeability state is {}.".format(state))


def check_review_initiated(value):
    if (value.get("requestCount") or 0) < 1:
        return blocked("No review has been initiated on this PR; run request first.")
    return passed("{} review request(s) so far.".format(value["requestCount"]))


def check_review_flow(value):
    state = value.get("state")
    if state == "submitted":
        if completion_summary(value):
            return passed("Codex review completed for the current HEAD with a matching completion summary.")
        return pending("Review submitted but completion is unconfirmed; poll until it settles.")
    if state in {"requested", "acknowledged"}:
        if value.get("canRequest"):
            return pending("A Codex review is in flight; poll until it settles.")
        return passed("A review is in flight but the request cap is exhausted; relying on local review.")
    if state == "stale":
        if value.get("canRequest"):
            return pending("The latest review targets an older commit; request another round.")
        return passed("The review is stale and the cap is exhausted; relying on local review.")
    if state == "refused":
        return passed("Codex refused the round on usage limits; relying on local review, as with an exhausted cap.")
    return pending("Review state is inconclusive; retry for a consistent snapshot.")


def check_threads_resolved(value):
    threads = value.get("threads")
    if not isinstance(threads, list):
        return blocked("Review threads were not collected; use a snapshot with threads.")
    unresolved = [thread for thread in threads if not thread.get("isResolved")]
    if unresolved:
        urls = []
        for thread in unresolved:
            nodes = (thread.get("comments") or {}).get("nodes") or []
            urls.append((nodes[0].get("url") if nodes else None) or thread["id"])
        return blocked("Unresolved review threads: " + ", ".join(urls))
    return passed("{} review thread(s), all resolved.".format(len(threads)))


def check_verification(value):
    if not isinstance(value.get("statuses"), list) or not isinstance(value.get("checkRuns"), list):
        return blocked("Commit statuses were not collected; use a snapshot with checks.")
    latest = {}
    for status in value["statuses"]:
        context = status["context"]
        if context not in latest or latest[context]["id"] < status["id"]:
            latest[context] = status
    signals = []
    for status in latest.values():
        if status["state"] == "pending":
            signals.append(pending("Commit status is pending: {}.".format(status["context"])))
        elif status["state"] != "success":
            signals.append(blocked("Commit status failed: {}.".format(status["context"])))
    # Evaluate every run, including same-named jobs: a newer success must not
    # hide another run's failure. Failures take precedence over pending signals.
    for check in value["checkRuns"]:
        if check["status"] != "completed":
            signals.append(pending("Check is running: {}.".format(check["name"])))
        elif check.get("conclusion") not in {"success", "neutral", "skipped"}:
            signals.append(blocked("Check failed: {}.".format(check["name"])))
    # The workflow attaches its check run to the merge commit, so a base change
    # replaces it; the recorded scope evidence still binds the tested head and base.
    runs = [check for check in value["checkRuns"] if check.get("name") == VERIFICATION_CHECK]
    if not runs:
        # A run whose publication fails takes the job's own check run down with it,
        # which the loop above reports as a failure; a run that never started is
        # still in flight, so wait for it rather than calling it blocked.
        signals.append(pending("No {} check run for this commit yet; wait for CI, or push the branch if none is scheduled.".format(VERIFICATION_CHECK)))
    else:
        run = max(runs, key=lambda check: check.get("id") or 0)
        if run["status"] != "completed":
            signals.append(pending("CI verification is {}.".format(run["status"])))
        elif run.get("conclusion") != "success":
            signals.append(blocked("CI verification concluded {}.".format(run.get("conclusion"))))
        else:
            proof = VERIFICATION_PROOF.search(((run.get("output") or {}).get("summary") or ""))
            if not proof or proof[2] != value.get("head") or proof[3] != value.get("baseSha") \
                    or value.get("verificationSnapshotStable") is not True:
                signals.append(blocked("CI verification evidence is missing or stale for the current HEAD and base; rerun the verify workflow."))
    for status in ("blocked", "pending"):
        for signal in signals:
            if signal["status"] == status:
                return signal
    return passed("CI verification succeeded; no failing statuses or checks.")


# Stable public check IDs preserve --only/--skip and JSON consumers. Each
# callable remains an independent policy atom over one snapshot.
GATE_CHECKS = {
    "checkPrOpen": check_pr_open,
    "checkMergeable": check_mergeable,
    "checkReviewInitiated": check_review_initiated,
    "checkReviewFlow": check_review_flow,
    "checkThreadsResolved": check_threads_resolved,
    "checkVerification": check_verification,
}


def select_checks(*, only=None, skip=None):
    checks = dict(GATE_CHECKS)
    available = ", ".join(GATE_CHECKS)
    if only:
        names = only.split(",")
        checks = {name: check for name, check in GATE_CHECKS.items() if name in names}
        if len(checks) != len(names):
            raise ValueError("Unknown check in --only; available: " + available)
    if skip:
        names = skip.split(",")
        if any(name not in GATE_CHECKS for name in names):
            raise ValueError("Unknown check in --skip; available: " + available)
        checks = {name: check for name, check in checks.items() if name not in names}
    if not checks:
        raise ValueError("The gate needs at least one check")
    return checks


def run_gate(value, checks=None):
    checks = GATE_CHECKS if checks is None else checks
    results = [{"check": name, **check(value)} for name, check in checks.items()]
    status = "ready"
    if any(result["status"] == "blocked" for result in results):
        status = "blocked"
    elif any(result["status"] == "pending" for result in results):
        status = "pending"
    return {"status": status, "exitCode": {"blocked": 1, "pending": 2, "ready": 0}[status], "checks": results}


def gate_view(value, result):
    return {**{key: value[key] for key in ("repo", "pr", "url", "head", "requestCount", "chargeableRounds",
                                          "requestsRemaining", "canRequest") if key in value}, **result}


def gate(repo, number, *, api=gh, only=None, skip=None):
    checks = select_checks(only=only, skip=skip)
    value = snapshot(repo, number, api=api, include_threads=True, include_checks=True)
    return gate_view(value, run_gate(value, checks))


def merge(repo, number, *, api=gh, run=gh_run, method="squash", check=False,
          settle_ms=REVIEW_SETTLE_MS, wait=sleep_ms, now=now_ms):
    def observe():
        value = snapshot(repo, number, api=api, include_threads=True, include_checks=True)
        return value, run_gate(value)

    def execute(value, result):
        merged = exec_merge(repo, number, value["head"], api=api, run=run, method=method)
        return {**gate_view(value, result), "status": "merged", "exitCode": 0, "merged": True, **merged}

    first, result = observe()
    if result["status"] != "ready":
        return {**gate_view(first, result), "merged": False}
    if check:
        return {**gate_view(first, result), "merged": False, "check": True}
    if not completion_summary(first):
        # Local-review fallback has no summary to settle; recheck just before merging.
        second, result = observe()
        if result["status"] != "ready":
            return {**gate_view(second, result), "merged": False}
        return execute(second, result)
    baseline, started_at = first, now()
    while True:
        if now() - started_at >= settle_ms:
            observation, result = observe()
            if result["status"] != "ready":
                return {**gate_view(observation, result), "merged": False}
            if review_fingerprint(observation) == review_fingerprint(baseline):
                return execute(observation, result)
            baseline, started_at = observation, now()
        wait(min(1000, max(0, settle_ms - (now() - started_at))))


HELP = """python3 scripts/pr-gate.py <status|comments|snapshot|poll|request|gate|merge> <PR number> [--repo owner/repo] [flags]
Atomic JSON commands. status/comments/snapshot read (snapshot is the full read model); poll waits for a settled review (a usage-limit refusal returns immediately with nextAction=gate); request confirms and settles the previous answer before posting one @codex review comment (max 5 total requests and 3 chargeable rounds; P0/P1 and refused rounds count toward the total but are not charged; refused rounds are re-requestable within the cap; refused while a round is in flight).
poll/request emit changing progress as JSON on stderr; final JSON remains on stdout. unrecognized-result means a Completed summary is visible but its review result format was not recognized.
gate applies GATE_CHECKS; --only/--skip refine gate only. merge always runs the full gate, observes a 5s settle window when a completion summary exists, then gh pr merge --match-head-commit (default squash; --merge/--rebase switch; --check dry-runs).
Exit: 0 ready/merged, 1 blocked or error, 2 pending or poll timeout, 3 request rejected (cap reached, round in flight, or PR not open)."""

READ_MODES = {"status": (False, False), "comments": (True, False), "snapshot": (True, True)}
VALUE_FLAGS = {"--repo", "--timeout", "--interval", "--settle", "--only", "--skip"}
BOOLEAN_FLAGS = {"--check", "--merge", "--rebase"}


def main(args, *, api=gh, run=gh_run):
    if args and args[0] == "--help":
        print(HELP)
        return 0
    if len(args) < 2 or args[0] not in {*READ_MODES, "poll", "request", "gate", "merge"} or not re.fullmatch(r"[1-9][0-9]*", args[1]):
        raise ValueError("Expected status|comments|snapshot|poll|request|gate|merge and a positive PR number; see --help")
    command, number = args[0], int(args[1])
    options, flags = {}, iter(args[2:])
    for flag in flags:
        if flag in VALUE_FLAGS:
            value = next(flags, None)
            if not value or flag in options:
                raise ValueError("Invalid or duplicate option: " + flag)
            options[flag] = value
        elif flag in BOOLEAN_FLAGS:
            if flag in options:
                raise ValueError("Duplicate option: " + flag)
            options[flag] = True
        else:
            raise ValueError("Invalid option: " + flag)

    def milliseconds(flag, default):
        try:
            return float(options.get(flag, default)) * 1000
        except ValueError:
            return math.nan

    timeout_ms = milliseconds("--timeout", 600)
    interval_ms = milliseconds("--interval", 15)
    settle_ms = milliseconds("--settle", 5)
    if not math.isfinite(settle_ms) or settle_ms < 1000:
        raise ValueError("Settle window must be at least 1 second")
    if not math.isfinite(timeout_ms) or timeout_ms <= 0 or not math.isfinite(interval_ms) or not 1000 <= interval_ms <= 60000:
        raise ValueError("Timeout must be positive; interval must be 1–60 seconds")
    if command != "gate" and (options.get("--only") or options.get("--skip")):
        raise ValueError("--only/--skip belong to the gate command")
    if command == "merge" and options.get("--merge") and options.get("--rebase"):
        raise ValueError("--merge and --rebase are mutually exclusive")
    if command != "merge" and any(options.get(flag) for flag in BOOLEAN_FLAGS):
        raise ValueError("--check/--merge/--rebase belong to the merge command")
    repo = options.get("--repo")
    if repo is None:
        repo = api(["repo", "view", "--json", "nameWithOwner"])["nameWithOwner"]
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo, re.ASCII):
        raise ValueError("Expected owner/repo")

    def progress(value):
        print(json.dumps(value, ensure_ascii=False), file=sys.stderr, flush=True)

    code = 0
    if command == "request":
        result = request_review(repo, number, api=api, on_progress=progress)
        code = 3 if result["rejected"] else 0
    elif command == "gate":
        result = gate(repo, number, api=api, only=options.get("--only"), skip=options.get("--skip"))
        code = result["exitCode"]
    elif command == "merge":
        method = "rebase" if options.get("--rebase") else "merge" if options.get("--merge") else "squash"
        result = merge(repo, number, api=api, run=run, check=options.get("--check", False), method=method)
        code = result["exitCode"]
    elif command == "poll":
        result = poll(lambda deadline: snapshot(repo, number, api=api, deadline=deadline, include_threads=True),
                      timeout_ms=timeout_ms, interval_ms=interval_ms, settle_ms=settle_ms, on_progress=progress)
        code = 2 if result["timedOut"] else 0
    else:
        threads, checks = READ_MODES[command]
        result = snapshot(repo, number, api=api, include_threads=threads, include_checks=checks)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return code


if __name__ == "__main__":
    try:
        exit_code = main(sys.argv[1:])
    except Exception as error:
        print(json.dumps({"state": "error", "error": str(error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        exit_code = 1
    sys.exit(exit_code)
