"""Purpose: Track session cost and trigger simple budget-aware degradation when spending gets too high."""

from typing import Any

from .models import BudgetState

# OpenAI pricing USD per token (2025 rates)
_PRICING: dict[str, dict[str, float]] = {
    "text-embedding-3-small": {"input": 0.02 / 1_000_000},
    "gpt-4o": {"input": 2.50 / 1_000_000, "output": 10.00 / 1_000_000},
}

# Rough per-step token estimates used for next-step forecasting
_STEP_ESTIMATES: dict[str, dict[str, Any]] = {
    "decompose":        {"model": "gpt-4o", "input": 300,  "output": 200},
    "embed_subquestion":{"model": "text-embedding-3-small", "input": 50},
    "extract_findings": {"model": "gpt-4o", "input": 800,  "output": 300},
    "synthesize":       {"model": "gpt-4o", "input": 1200, "output": 500},
}


def compute_openai_cost(model: str, input_tokens: int, output_tokens: int = 0) -> float:
    p = _PRICING.get(model, {})
    return round(input_tokens * p.get("input", 0.0) + output_tokens * p.get("output", 0.0), 8)


def estimate_step_cost(step: str) -> float:
    est = _STEP_ESTIMATES.get(step)
    if not est:
        return 0.0
    p = _PRICING[est["model"]]
    cost = est["input"] * p["input"]
    if "output" in est:
        cost += est["output"] * p.get("output", 0.0)
    return round(cost, 8)


class BudgetTracker:
    def __init__(self, cap_usd: float) -> None:
        self.cap_usd = cap_usd
        self.spent_usd = 0.0
        self._next_estimate = 0.0

    def record_spend(self, amount: float) -> None:
        self.spent_usd = round(self.spent_usd + amount, 8)

    def set_next_step_estimate(self, step: str) -> None:
        self._next_estimate = estimate_step_cost(step)

    def is_near_limit(self, threshold: float = 0.80) -> bool:
        return self.spent_usd >= self.cap_usd * threshold

    def is_over_limit(self) -> bool:
        return self.spent_usd >= self.cap_usd

    def get_state(self) -> BudgetState:
        return BudgetState(
            cap_usd=self.cap_usd,
            spent_usd=round(self.spent_usd, 6),
            remaining_usd=round(max(0.0, self.cap_usd - self.spent_usd), 6),
            estimated_next_step_usd=round(self._next_estimate, 6),
        )

