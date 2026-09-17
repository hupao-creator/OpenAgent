"""GitHub observations and review lifecycle operations, independent of gate policy."""

import json
import math
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone


BOT = "chatgpt-codex-connector[bot]"
MAX_REVIEW_ROUNDS = 3
MAX_TOTAL_ROUNDS = 5
REQUEST_RE = re.compile(r"^@codex review(?:\s|$)", re.I)
USAGE_LIMIT_RE = re.compile(r"reached your Codex usage limits", re.I)
CLEAN_RESULT_RE = re.compile(r"^Codex Review: Didn't find any major issues\.(?:[^\n]*)\n")
REVIEWED_COMMIT_RE = re.compile(r"^\*\*Reviewed commit:\*\* `([a-f0-9]{7,40})`\s*$", re.M)
TRUSTED_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}


def now_ms():
    return int(time.time() * 1000)


def sleep_ms(milliseconds):
    time.sleep(milliseconds / 1000)


def parse_time(value):
    if not isinstance(value, str):
        return math.nan
    try:
        # Match GitHub/Date.parse millisecond precision, including longer fractions.
        value = re.sub(r"\.(\d+)", lambda m: "." + m[1][:3].ljust(3, "0"), value)
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except (ValueError, OverflowError):
        return math.nan


def is_bot(item):
    return (item.get("user") or {}).get("login") == BOT


def is_request(comment):
    return bool(REQUEST_RE.search(comment.get("body") or "")) and comment.get("author_association") in TRUSTED_ASSOCIATIONS


def recent(items, key):
    return next(iter(sorted(items, key=lambda item: parse_time(item.get(key)), reverse=True)), None)


def targets_head(review, head):
    return head.startswith(review["commit_id"]) if review.get("source") == "comment" else review.get("commit_id") == head


def classify(*, head, reviews, comments, reactions=(), inline=()):
    requests = [comment for comment in comments if is_request(comment)]
    request = recent(requests, "created_at")
    requestish = [comment for comment in comments if REQUEST_RE.search(comment.get("body") or "")]

    def trusted_trigger(review):
        # Outsider comments cannot shadow a trusted request. Proactive reviews
        # with no triggering comment retain their original treatment.
        submitted = parse_time(review.get("submitted_at"))
        if any(parse_time(comment.get("created_at")) < submitted for comment in requests):
            return True
        return not any(parse_time(comment.get("created_at")) < submitted for comment in requestish)

    def trigger_id(review):
        trigger = recent([comment for comment in requests
                          if parse_time(comment.get("created_at")) < parse_time(review.get("submitted_at"))], "created_at")
        return trigger.get("id") if trigger else None

    formal = [review for review in reviews if is_bot(review) and review.get("submitted_at")
              and trusted_trigger(review) and review.get("state") in {"APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"}]
    # Both result carriers can answer one request; prefer the formal review and
    # count repeated clean-result comments only once per trusted request.
    answered_requests = {trigger_id(review) for review in formal}
    comment_reviews = []
    for comment in sorted(comments, key=lambda item: parse_time(item.get("created_at")), reverse=True):
        if not is_bot(comment) or not CLEAN_RESULT_RE.search(comment.get("body") or ""):
            continue
        commit = REVIEWED_COMMIT_RE.search(comment["body"])
        if not commit or not math.isfinite(parse_time(comment.get("created_at"))):
            continue
        candidate = {**comment, "source": "comment", "id": "comment:{}".format(comment["id"]),
                     "state": "COMMENTED", "commit_id": commit[1], "submitted_at": comment["created_at"]}
        trigger = trigger_id(candidate)
        if trigger is None or trigger in answered_requests:
            continue
        answered_requests.add(trigger)
        comment_reviews.append(candidate)

    finished = formal + comment_reviews
    submitted = [review for review in finished if review["state"] != "DISMISSED"]
    chargeable = sum(not any(comment.get("pull_request_review_id") == review["id"] and is_bot(comment)
                            and re.search(r"!\[P[01] Badge\]", comment.get("body") or "") for comment in inline)
                    for review in finished)
    latest = recent(finished, "submitted_at")
    current = recent([review for review in submitted if targets_head(review, head)
                      and (request is None or parse_time(review.get("submitted_at")) > parse_time(request.get("created_at")))], "submitted_at")
    acknowledged = any(is_bot(reaction) and reaction.get("content") == "eyes" for reaction in reactions)
    answered = latest is not None and (request is None or parse_time(latest.get("submitted_at")) > parse_time(request.get("created_at")))
    # Only the provider's own refusal after the latest request voids that round.
    refused = request is not None and any(is_bot(comment) and USAGE_LIMIT_RE.search(comment.get("body") or "")
                                         and parse_time(comment.get("created_at")) > parse_time(request.get("created_at")) for comment in comments)
    state = "unknown"
    reason = "No conclusive evidence of a completed review for the current HEAD."
    if current is not None:
        state, reason = "submitted", "A review was submitted for HEAD; inline findings may still be arriving."
    elif answered:
        state, reason = "stale", "The latest Codex review no longer stands on HEAD; it targets another commit or was dismissed."
    elif request is not None:
        if refused:
            state, reason = "refused", "Codex declined the round on usage limits; rely on a local review."
        else:
            state = "acknowledged" if acknowledged else "requested"
            reason = "A manual request is visible; its target commit and completion are not established."
    request_view = None
    if request is not None:
        request_view = {target: request[source] for target, source in
                        (("id", "id"), ("url", "html_url"), ("createdAt", "created_at")) if source in request}
    return {"state": state, "reason": reason, "head": head, "request": request_view,
            "latestReview": latest, "currentReview": current, "acknowledged": acknowledged,
            "reactions": [reaction for reaction in reactions if is_bot(reaction)],
            "stale": not targets_head(latest, head) if latest else None,
            "requestCount": len(requests), "requestLimit": MAX_REVIEW_ROUNDS, "chargeableRounds": chargeable,
            "requestsRemaining": max(0, min(MAX_REVIEW_ROUNDS - chargeable, MAX_TOTAL_ROUNDS - len(requests))),
            "canRequest": chargeable < MAX_REVIEW_ROUNDS and len(requests) < MAX_TOTAL_ROUNDS}


def _run_gh(args, timeout):
    try:
        result = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("gh {}: {}".format(" ".join(args), error)) from error
    if result.returncode:
        raise RuntimeError("gh {}: {}".format(" ".join(args), result.stderr.strip() or "exit {}".format(result.returncode)))
    if any(len(stream.encode("utf-8")) > 32 * 1024 * 1024 for stream in (result.stdout, result.stderr)):
        raise RuntimeError("gh output exceeded 32 MiB")
    return result.stdout


def gh(args, deadline=math.inf):
    remaining = deadline - now_ms()
    if remaining <= 0:
        raise RuntimeError("Polling deadline exceeded")
    result = json.loads(_run_gh(args, min(30000, remaining) / 1000))
    if isinstance(result, dict) and result.get("errors") is not None:
        raise RuntimeError(json.dumps(result["errors"]))
    return result


def _parallel(*operations):
    with ThreadPoolExecutor(max_workers=len(operations)) as executor:
        futures = [executor.submit(operation) for operation in operations]
        return [future.result() for future in futures]


def _flatten(pages):
    return [item for page in pages for item in (page if isinstance(page, list) else [page])]


def snapshot(repo, number, *, api=gh, deadline=math.inf, include_threads=False, include_checks=False):
    root = "repos/{}".format(repo)

    def one(path):
        return api(["api", path], deadline)

    def listing(path):
        separator = "&" if "?" in path else "?"
        return _flatten(api(["api", "--paginate", "--slurp", path + separator + "per_page=100"], deadline))

    pr, reviews, comments, inline = _parallel(
        lambda: one("{}/pulls/{}".format(root, number)),
        lambda: listing("{}/pulls/{}/reviews".format(root, number)),
        lambda: listing("{}/issues/{}/comments".format(root, number)),
        lambda: listing("{}/pulls/{}/comments".format(root, number)),
    )
    request = recent([comment for comment in comments if is_request(comment)], "created_at")
    reactions = listing("{}/issues/comments/{}/reactions".format(root, request["id"])) if request else []
    threads, thread_heads = [], set()
    if include_threads:
        owner, name = repo.split("/")
        query = ("query($owner:String!,$name:String!,$number:Int!,$endCursor:String){"
                 "repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid "
                 "reviewThreads(first:100,after:$endCursor){nodes{id isResolved isOutdated path line "
                 "comments(first:1){nodes{author{login} databaseId url}}} pageInfo{hasNextPage endCursor}}}}}")
        pages = api(["api", "graphql", "--paginate", "--slurp", "-f", "query=" + query,
                     "-f", "owner=" + owner, "-f", "name=" + name, "-F", "number=" + str(number)], deadline)
        for page in pages:
            if page.get("errors") is not None:
                raise RuntimeError(json.dumps(page["errors"]))
            pull = page["data"]["repository"]["pullRequest"]
            thread_heads.add(pull["headRefOid"])
            threads.extend(pull["reviewThreads"]["nodes"])
    root_ids = {comment.get("in_reply_to_id") or comment["id"] for comment in inline if is_bot(comment)}
    discussions = [comment for comment in inline if (comment.get("in_reply_to_id") or comment["id"]) in root_ids]
    after = one("{}/pulls/{}".format(root, number))
    latest = after
    statuses, check_runs, merge_sha = [], [], None
    if include_checks:
        sha = after["head"]["sha"]
        merge_sha = after.get("merge_commit_sha")
        # The verify workflow attaches its check run to the verified head, but the
        # job's own check run and anything else GitHub records can land on either
        # commit, so read both; neither set can hide a failure.
        shas = [sha] + ([merge_sha] if merge_sha and merge_sha != sha else [])
        collected = _parallel(
            lambda: listing("{}/commits/{}/statuses".format(root, sha)),
            *[lambda target=target: listing("{}/commits/{}/check-runs?filter=all".format(root, target)) for target in shas],
        )
        statuses = collected[0]
        check_runs = [check for pages in collected[1:] for page in pages for check in page.get("check_runs", [])]
        latest = one("{}/pulls/{}".format(root, number))
    head = latest["head"]["sha"]
    status = classify(head=head, reviews=reviews, comments=comments, reactions=reactions, inline=inline)
    # Bind each collection to its own HEAD observation, including A -> B -> A.
    if pr["head"]["sha"] != head or after["head"]["sha"] != head or (thread_heads and thread_heads != {head}):
        status.update(state="unknown", reason="PR HEAD changed during collection; retry for a consistent snapshot.")
    thread_by_root = {thread["comments"]["nodes"][0].get("databaseId"): thread
                      for thread in threads if thread["comments"]["nodes"]}
    result = {"repo": repo, "pr": number, "draft": latest.get("draft") or False,
              "mergeable": latest.get("mergeable"), "mergeableState": latest.get("mergeable_state") or "unknown", **status,
              "comments": [comment for comment in comments if is_bot(comment)],
              "reviews": [review for review in reviews if is_bot(review)],
              "inlineComments": [{**comment, "thread": thread_by_root.get(comment.get("in_reply_to_id") or comment["id"])}
                                 for comment in discussions],
              "observationStable": False, "collectedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    if "html_url" in pr:
        result["url"] = pr["html_url"]
    if "state" in latest:
        result["prState"] = latest["state"]
    if include_threads:
        result["threads"] = threads
    if include_checks:
        # The final read decides which base the merge commit belongs to, so a base
        # that moves while the checks are collected leaves the evidence stale.
        result.update(statuses=statuses, checkRuns=check_runs, baseSha=(latest.get("base") or {}).get("sha"),
                      mergeCommitSha=merge_sha,
                      verificationSnapshotStable=all((item.get("head") or {}).get("sha") == head
                                                         and (item.get("base") or {}).get("sha") == (latest.get("base") or {}).get("sha")
                                                     for item in (pr, after, latest)))
    return result


def _matching_summary(value, after, matches_commit=None):
    if matches_commit is None:
        matches_commit = lambda commit: value["head"].startswith(commit)
    for comment in value.get("comments", []):
        if not is_bot(comment) or "<!-- codex-pull-request-review-summary -->" not in comment.get("body", ""):
            continue
        for row in comment["body"].split("\n"):
            if not row.startswith("|") or "**Code Review**" not in row or "**Completed**" not in row:
                continue
            commit = re.search(r"`([a-f0-9]{7,40})`", row)
            timestamp = re.search(r'datetime="([^"]+)"', row)
            completed_at = parse_time(timestamp[1] if timestamp else None)
            updated_at = parse_time(comment.get("updated_at"))
            request = value.get("request")
            # REST timestamps omit fractions; compare to the embedded timestamp
            # at their shared precision, without accepting a later second.
            if (commit and matches_commit(commit[1]) and completed_at >= after
                    and math.isfinite(updated_at) and math.floor(updated_at / 1000) >= math.floor(completed_at / 1000)
                    and (request is None or completed_at > parse_time(request.get("createdAt")))):
                return {"id": comment["id"], "updatedAt": comment["updated_at"], "completedAt": timestamp[1]}
    return None


def _summary_for_review(value, review, matches_commit):
    times = [parse_time(review.get("submitted_at")), parse_time(review.get("updated_at") or review.get("submitted_at"))]
    for comment in value.get("inlineComments", []):
        if not is_bot(comment):
            continue
        updated = parse_time(comment.get("updated_at") or comment.get("created_at"))
        belongs = (updated >= parse_time((value.get("request") or {}).get("createdAt"))
                   if review.get("source") == "comment" else comment.get("pull_request_review_id") == review.get("id"))
        if belongs:
            times.append(updated)
    # Malformed timestamps cannot prove completion.
    after = max(times) if all(math.isfinite(value) for value in times) else math.nan
    return _matching_summary(value, after, matches_commit)


def completion_summary(value):
    if value.get("state") != "submitted" or not value.get("currentReview"):
        return None
    return _summary_for_review(value, value["currentReview"], lambda commit: value["head"].startswith(commit))


def review_fingerprint(value):
    return json.dumps([value.get(key) for key in ("head", "request", "currentReview", "latestReview", "reviews", "comments", "inlineComments", "threads")],
                      ensure_ascii=False, separators=(",", ":"))


def poll(read, *, timeout_ms=600000, interval_ms=15000, settle_ms=5000, now=now_ms,
         wait=sleep_ms, summary_for=completion_summary, on_progress=None):
    deadline = now() + timeout_ms
    latest = fingerprint = unchanged_since = progress_fingerprint = diagnostic = None

    def report(phase, reason):
        nonlocal progress_fingerprint
        progress = {"phase": phase}
        if latest:
            for key, source in (("head", latest), ("requestId", latest.get("request") or {}),
                                ("reviewUrl", latest.get("currentReview") or {})):
                source_key = {"requestId": "id", "reviewUrl": "html_url"}.get(key, key)
                if source_key in source:
                    progress[key] = source[source_key]
        if reason is not None:
            progress["reason"] = reason
        signature = json.dumps([progress, fingerprint], ensure_ascii=False)
        if signature != progress_fingerprint:
            progress_fingerprint = signature
            if on_progress:
                on_progress(progress)

    while now() < deadline:
        try:
            latest = read(deadline)
        except Exception:
            if now() >= deadline:
                break
            raise
        if latest.get("state") == "refused":
            reason = "Codex refused the round on usage limits; run gate and rely on local review."
            report("refused", reason)
            return {**latest, "reason": reason, "observationStable": False,
                    "timedOut": False, "nextAction": "gate"}
        summary = summary_for(latest)
        diagnostic = ("A matching Completed summary is visible, but no supported review result is recognized; inspect the bot comments."
                      if not latest.get("currentReview") and _matching_summary(latest, 0) else None)
        next_fingerprint = review_fingerprint(latest) if summary else None
        if next_fingerprint is None or next_fingerprint != fingerprint:
            fingerprint = next_fingerprint
            unchanged_since = None if next_fingerprint is None else now()
        report("settling" if summary else "unrecognized-result" if diagnostic else latest["state"],
               "Completion confirmed; observing the review stream for delayed findings." if summary else diagnostic or latest.get("reason"))
        if summary and unchanged_since is not None and now() < deadline and now() - unchanged_since >= settle_ms:
            report("settled", "The review stream remained unchanged across the settle window; read the findings before merging.")
            return {**latest, "reviewState": latest["state"], "state": "settled",
                    "reason": "Matching completion summary and unchanged observations across the settle window; not a merge approval or proof that no later findings can arrive.",
                    "observationStable": True, "settleMs": settle_ms, "summary": summary, "timedOut": False}
        delay = min(interval_ms, deadline - now())
        if unchanged_since is not None:
            delay = min(delay, settle_ms - (now() - unchanged_since))
        wait(max(0, delay))
    report("timed-out", diagnostic or "Review did not settle before the polling deadline.")
    return {**(latest or {"state": "unknown"}), **({"diagnostic": diagnostic} if diagnostic else {}),
            "observationStable": False, "timedOut": True}


def _answered_round_summary(value):
    if value.get("state") not in {"submitted", "stale"} or not value.get("latestReview"):
        return None
    reviewed = value["latestReview"]["commit_id"]
    return _summary_for_review(value, value["latestReview"], lambda commit: reviewed.startswith(commit) or commit.startswith(reviewed))


def request_review(repo, number, *, api=gh, timeout_ms=180000, interval_ms=15000, settle_ms=5000,
                   now=now_ms, wait=sleep_ms, on_progress=None):
    observed = snapshot(repo, number, api=api)

    def reject(reason):
        return {"repo": repo, "pr": number, **{key: observed[key] for key in
                ("url", "prState", "requestCount", "chargeableRounds", "requestsRemaining", "canRequest") if key in observed},
                "rejected": True, "reason": reason, "requestLimit": MAX_REVIEW_ROUNDS}

    def reject_limit():
        if observed["requestCount"] >= MAX_TOTAL_ROUNDS:
            return reject("Total request limit of {} rounds reached; rely on a local review.".format(MAX_TOTAL_ROUNDS))
        return reject("Request limit of {} chargeable rounds reached; rely on a local review.".format(MAX_REVIEW_ROUNDS))

    if observed.get("prState") != "open":
        return reject("PR is not open; review requests are only accepted on open pull requests.")
    if not observed["canRequest"]:
        return reject_limit()
    if observed["state"] in {"requested", "acknowledged"}:
        return reject("An earlier review request is still in flight; wait for it to complete before requesting another round.")
    if observed["request"] and observed["state"] in {"submitted", "stale"}:
        if not _answered_round_summary(observed):
            return reject("Previous review completion is unconfirmed; wait for its matching completion summary before requesting another round.")
        changed = False

        def read(deadline):
            nonlocal changed
            value = snapshot(repo, number, api=api, deadline=deadline)
            if (value.get("prState") != "open" or value["state"] == "unknown" or value["head"] != observed["head"]
                    or (value.get("request") or {}).get("id") != observed["request"]["id"]):
                changed = True
                raise RuntimeError("Review requests, HEAD or PR state changed during evaluation.")
            return value

        try:
            settled = poll(read, timeout_ms=timeout_ms, interval_ms=interval_ms, settle_ms=settle_ms,
                           now=now, wait=wait, on_progress=on_progress, summary_for=_answered_round_summary)
            if not settled["observationStable"]:
                return reject("Previous review has not settled; no new request was posted.")
            observed = settled
        except Exception:
            if changed:
                return reject("Review requests, HEAD or PR state changed during evaluation; retry for a consistent view.")
            raise
    # Shrink the concurrent-request race by re-reading immediately before POST.
    recheck = snapshot(repo, number, api=api)
    if recheck.get("prState") != "open":
        return reject("PR is no longer open; review requests are only accepted on open pull requests.")
    if (recheck["requestCount"] != observed["requestCount"] or recheck["state"] != observed.get("reviewState", observed["state"])
            or review_fingerprint(recheck) != review_fingerprint(observed)):
        return reject("Review requests changed during evaluation; retry for a consistent view.")
    observed = recheck
    if not observed["canRequest"]:
        return reject_limit()
    posted = api(["api", "-X", "POST", "repos/{}/issues/{}/comments".format(repo, number), "-f", "body=@codex review"])
    charged = observed.get("chargeableRounds", 0)
    return {"repo": repo, "pr": number, **{key: observed[key] for key in ("url", "prState") if key in observed}, "rejected": False,
            "posted": {target: posted[source] for target, source in
                       (("id", "id"), ("url", "html_url"), ("createdAt", "created_at")) if source in posted},
            "requestCount": observed["requestCount"] + 1, "requestLimit": MAX_REVIEW_ROUNDS, "chargeableRounds": charged,
            "requestsRemaining": max(0, min(MAX_REVIEW_ROUNDS - charged, MAX_TOTAL_ROUNDS - observed["requestCount"] - 1)),
            "canRequest": charged < MAX_REVIEW_ROUNDS and observed["requestCount"] + 1 < MAX_TOTAL_ROUNDS}


def gh_run(args):
    return _run_gh(args, 60).strip()


def exec_merge(repo, number, head, *, api=gh, run=gh_run, method="squash"):
    # gh enforces the remaining HEAD race at the actual merge operation.
    run(["pr", "merge", str(number), "--repo", repo, "--" + method, "--match-head-commit", head])
    merged = api(["api", "repos/{}/pulls/{}".format(repo, number)])
    if merged.get("merged") is not True or merged.get("state") != "closed" or (merged.get("head") or {}).get("sha") != head:
        raise RuntimeError("Merge command returned but the merge could not be confirmed; the PR may have been enqueued in a merge queue instead of merging synchronously. Inspect the PR before retrying")
    return {"mergeCommitSha": merged.get("merge_commit_sha")}
