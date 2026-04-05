from backend.memory import SessionMemory
from backend.models import FindingCard


def make_finding(index: int) -> FindingCard:
    return FindingCard(
        id=f"finding_{index}",
        subquestion_id="sq_1",
        claim=f"claim {index}",
        source_ids=[f"paper_{index}"],
        confidence=0.8,
        created_at="2026-04-05T14:00:00Z",
    )


def test_session_memory_drops_oldest_findings_when_full() -> None:
    memory = SessionMemory(max_findings=3)

    for index in range(4):
        memory.add_finding(make_finding(index))

    findings = memory.get_findings()

    assert [finding.id for finding in findings] == [
        "finding_1",
        "finding_2",
        "finding_3",
    ]


def test_session_memory_can_compress_when_near_capacity() -> None:
    memory = SessionMemory(max_findings=4)

    for index in range(3):
        memory.add_finding(make_finding(index))

    summary = memory.maybe_compress()

    assert summary is not None
    assert summary.startswith("Prior findings:")
    assert "claim 0" in summary
