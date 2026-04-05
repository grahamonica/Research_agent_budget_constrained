from backend.budget import BudgetTracker, compute_openai_cost, estimate_step_cost


def test_compute_openai_cost_uses_model_pricing() -> None:
    cost = compute_openai_cost("gpt-4o", input_tokens=1_000, output_tokens=500)

    assert cost == 0.0075


def test_estimate_step_cost_returns_zero_for_unknown_step() -> None:
    assert estimate_step_cost("missing-step") == 0.0


def test_budget_tracker_updates_state_and_thresholds() -> None:
    tracker = BudgetTracker(cap_usd=0.05)

    tracker.set_next_step_estimate("decompose")
    tracker.record_spend(0.041)
    state = tracker.get_state()

    assert state.cap_usd == 0.05
    assert state.spent_usd == 0.041
    assert state.remaining_usd == 0.009
    assert state.estimated_next_step_usd > 0
    assert tracker.is_near_limit() is True
    assert tracker.is_over_limit() is False

    tracker.record_spend(0.01)
    assert tracker.is_over_limit() is True
