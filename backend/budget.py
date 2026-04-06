"""Purpose: Track session cost, explicit sub-budgets, and budget-aware step rebalancing."""

from __future__ import annotations

from .models import BudgetAllocation, BudgetState

# OpenAI pricing USD per token (2025 rates)
_PRICING: dict[str, dict[str, float]] = {
    "text-embedding-3-small": {"input": 0.02 / 1_000_000},
    "gpt-4o": {"input": 2.50 / 1_000_000, "output": 10.00 / 1_000_000},
}

# Rough per-step token estimates used for next-step forecasting
_STEP_ESTIMATES: dict[str, dict[str, float | str]] = {
    "decompose": {"model": "gpt-4o", "input": 400, "output": 250},
    "retrieve": {"model": "text-embedding-3-small", "input": 1_200},
    "extract": {"model": "gpt-4o", "input": 1_400, "output": 450},
    "synthesize": {"model": "gpt-4o", "input": 1_500, "output": 550},
}


def compute_openai_cost(model: str, input_tokens: int, output_tokens: int = 0) -> float:
    p = _PRICING.get(model, {})
    return round(input_tokens * p.get("input", 0.0) + output_tokens * p.get("output", 0.0), 8)


def estimate_step_cost(step: str) -> float:
    est = _STEP_ESTIMATES.get(step)
    if not est:
        return 0.0
    p = _PRICING[str(est["model"])]
    cost = float(est["input"]) * p["input"]
    if "output" in est:
        cost += float(est["output"]) * p.get("output", 0.0)
    return round(cost, 8)


class BudgetTracker:
    def __init__(self, cap_usd: float) -> None:
        self.cap_usd = cap_usd
        self.spent_usd = 0.0
        self._next_estimate = 0.0
        self._active_key: str | None = None
        self._allocations: dict[str, BudgetAllocation] = {}
        self._order: list[str] = []
        self._ensure_base_plan()

    def _ensure_base_plan(self) -> None:
        if "decompose" in self._allocations:
            return
        self._upsert_allocation(
            "decompose",
            "Decompose query",
            round(self.cap_usd * 0.10, 6),
        )


    def _upsert_allocation(self, key: str, label: str, allocated_usd: float) -> None:
        allocated = round(max(0.0, allocated_usd), 6)
        existing = self._allocations.get(key)
        if existing is None:
            self._allocations[key] = BudgetAllocation(
                key=key,
                label=label,
                allocated_usd=allocated,
                spent_usd=0.0,
                remaining_usd=allocated,
            )
            self._order.append(key)
            return

        existing.label = label
        existing.allocated_usd = allocated
        existing.remaining_usd = round(max(0.0, allocated - existing.spent_usd), 6)
        if existing.status == "depleted" and existing.remaining_usd > 0:
            existing.status = "planned"

    def plan_research(self, subquestion_ids: list[str]) -> None:
        sq_count = max(1, len(subquestion_ids))
        synthesis_budget = round(self.cap_usd * 0.20, 6)
        decompose_budget = self._allocations["decompose"].allocated_usd
        work_budget = round(max(0.0, self.cap_usd - decompose_budget - synthesis_budget), 6)
        per_sq = work_budget / sq_count if sq_count else 0.0

        self._upsert_allocation("synthesize", "Synthesize final answer", synthesis_budget)
        for sq_id in subquestion_ids:
            self._upsert_allocation(
                f"retrieve:{sq_id}",
                f"Retrieve papers for {sq_id}",
                round(per_sq * 0.42, 6),
            )
            self._upsert_allocation(
                f"extract:{sq_id}",
                f"Extract findings for {sq_id}",
                round(per_sq * 0.58, 6),
            )

    def activate(self, key: str) -> None:
        if key not in self._allocations:
            return
        if self._active_key and self._active_key in self._allocations:
            current = self._allocations[self._active_key]
            if current.status == "active":
                current.status = "planned"
        self._active_key = key
        allocation = self._allocations[key]
        if allocation.status not in {"completed", "skipped", "depleted"}:
            allocation.status = "active"

    def complete(self, key: str) -> None:
        allocation = self._allocations.get(key)
        if allocation is None:
            return
        allocation.status = "depleted" if allocation.remaining_usd <= 0 else "completed"
        if self._active_key == key:
            self._active_key = None

    def skip(self, key: str) -> None:
        allocation = self._allocations.get(key)
        if allocation is None:
            return
        allocation.status = "skipped"
        if self._active_key == key:
            self._active_key = None

    def record_spend(self, amount: float, allocation_key: str | None = None) -> None:
        spend = round(max(0.0, amount), 8)
        self.spent_usd = round(self.spent_usd + spend, 8)
        key = allocation_key or self._active_key
        if key and key in self._allocations:
            allocation = self._allocations[key]
            allocation.spent_usd = round(allocation.spent_usd + spend, 6)
            allocation.remaining_usd = round(max(0.0, allocation.allocated_usd - allocation.spent_usd), 6)
            if allocation.remaining_usd <= 0 and allocation.status not in {"completed", "skipped"}:
                allocation.status = "depleted"

    def set_next_step_estimate(self, step: str, allocation_key: str | None = None) -> None:
        estimate = estimate_step_cost(step)
        if allocation_key and allocation_key in self._allocations:
            estimate = min(estimate, self.available_for(allocation_key))
        self._next_estimate = round(max(0.0, estimate), 8)

    def set_next_step_estimate_amount(self, amount: float) -> None:
        self._next_estimate = round(max(0.0, amount), 8)

    def available_for(self, key: str) -> float:
        if key not in self._allocations:
            return 0.0
        total_remaining = max(0.0, self.cap_usd - self.spent_usd)
        reserved_for_others = 0.0
        for other_key, allocation in self._allocations.items():
            if other_key == key:
                continue
            if allocation.status in {"planned", "active"}:
                reserved_for_others += allocation.remaining_usd
        return round(max(0.0, total_remaining - reserved_for_others), 6)

    def allocation_remaining(self, key: str) -> float:
        allocation = self._allocations.get(key)
        if allocation is None:
            return 0.0
        return allocation.remaining_usd

    def is_near_limit(self, threshold: float = 0.80) -> bool:
        return self.spent_usd >= self.cap_usd * threshold

    def is_over_limit(self) -> bool:
        return self.spent_usd >= self.cap_usd

    def get_state(self) -> BudgetState:
        allocations = [
            self._allocations[key].model_copy()
            for key in self._order
        ]
        return BudgetState(
            cap_usd=self.cap_usd,
            spent_usd=round(self.spent_usd, 6),
            remaining_usd=round(max(0.0, self.cap_usd - self.spent_usd), 6),
            estimated_next_step_usd=round(self._next_estimate, 6),
            active_allocation_key=self._active_key,
            allocations=allocations,
        )
