"""Purpose: Store retained findings and optional lightweight session summaries for bounded-memory research."""

from collections import deque

from .models import FindingCard


class SessionMemory:
    def __init__(self, max_findings: int = 20) -> None:
        self._max = max_findings
        self._findings: deque[FindingCard] = deque()
        self.summary: str | None = None

    def add_finding(self, finding: FindingCard) -> None:
        self._findings.append(finding)
        if len(self._findings) > self._max:
            self._findings.popleft()

    def get_findings(self) -> list[FindingCard]:
        return list(self._findings)

    def maybe_compress(self) -> str | None:
        """Produce a brief summary of the oldest half of findings when near capacity."""
        if len(self._findings) < self._max // 2:
            return None
        old = list(self._findings)[: self._max // 2]
        self.summary = "Prior findings: " + "; ".join(f.claim for f in old[:5])
        return self.summary
