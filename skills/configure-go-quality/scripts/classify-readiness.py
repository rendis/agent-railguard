#!/usr/bin/env python3
"""Return one deterministic Go quality configuration readiness result."""

from __future__ import annotations

import argparse
import json


STRUCTURED_STATUS = {
    "READY": "ready",
    "READY_WITH_FINDINGS": "ready_with_findings",
    "MISSING": "missing",
    "BROKEN": "broken",
    "BLOCKED_SETUP": "blocked_setup",
}


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Classify configuration inputs, blocked prerequisites, and product findings."
    )
    parser.add_argument(
        "--inputs",
        required=True,
        choices=("ready", "missing", "broken"),
        help="State of repository-owned reproducibility inputs.",
    )
    parser.add_argument(
        "--blocked-prerequisite",
        action="append",
        default=[],
        metavar="LABEL",
        help="Unavailable required prerequisite; may be repeated.",
    )
    parser.add_argument(
        "--product-finding",
        action="append",
        default=[],
        metavar="LABEL",
        help="Executed product or quality failure; may be repeated.",
    )
    return parser.parse_args()


def classify(arguments: argparse.Namespace) -> str:
    if arguments.inputs == "missing":
        return "MISSING"
    if arguments.inputs == "broken":
        return "BROKEN"
    if arguments.blocked_prerequisite:
        return "BLOCKED_SETUP"
    if arguments.product_finding:
        return "READY_WITH_FINDINGS"
    return "READY"


def main() -> None:
    state = classify(parse_arguments())
    print(json.dumps({"state": state, "status": STRUCTURED_STATUS[state]}))


if __name__ == "__main__":
    main()
