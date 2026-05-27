"""
Agentic Patterns Starter — Python
Run: python main.py --goal "your goal here"
"""

import asyncio
import sys
import time

from dotenv import load_dotenv
load_dotenv()

from src.core.blackboard import Blackboard, BudgetExceededError
from src.core.dag_runner import DAGRunner
from src.agents.planner_agent import PlannerAgent
from src.agents.researcher_agent import ResearcherAgent


async def main():
    goal = sys.argv[sys.argv.index("--goal") + 1] if "--goal" in sys.argv else (
        "Research and explain the key patterns for building production multi-agent AI systems"
    )

    print("━" * 60)
    print(" Agentic Patterns Starter (Python)")
    print("━" * 60)
    print(f"Goal: {goal}\n")

    blackboard = Blackboard(goal)

    # ── Define the pipeline as a DAG ──────────────────────────────────────────
    #
    #   Planner ──→ Researcher
    #
    # To add agents: runner.add_node("Coder", CoderAgent(), input_from=["Planner", "Researcher"])

    runner = DAGRunner()
    runner.add_node("Planner",    PlannerAgent(),    input_from=[])
    runner.add_node("Researcher", ResearcherAgent(), input_from=["Planner"])

    start = time.time()

    try:
        await runner.run(blackboard)

        elapsed = time.time() - start
        summary = blackboard.summary()

        print(f"\n{'━' * 60}")
        print(" Pipeline Complete")
        print("━" * 60)
        print(f"Time:  {elapsed:.1f}s")
        print(f"Cost:  {summary['total_cost']}")
        print(f"Notes: {summary['notes_count']} entries")
        print("\n── Research Summary " + "─" * 41 + "\n")
        print(blackboard.artifacts.get("research_summary", "(no summary produced)"))
        print("\n" + "━" * 60)

    except BudgetExceededError as err:
        print(f"\n[budget] Pipeline stopped: {err}")
    except Exception as err:
        print(f"\n[error] Pipeline failed: {err}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
