from src.core.base_agent import BaseAgent
from src.core.blackboard import Blackboard


class ResearcherAgent(BaseAgent):
    def __init__(self):
        super().__init__("Researcher")

    def system_prompt(self) -> str:
        return """You are a research and synthesis agent. Given a goal and a plan, provide a thorough research summary.

Focus on: key concepts, current state of the field, practical trade-offs, implementation considerations.
Be specific and factual. Write in clear prose, 3-5 paragraphs."""

    def build_prompt(self, goal: str, context: str, blackboard: Blackboard) -> str:
        plan = blackboard.artifacts.get("plan")
        plan_text = (
            "Plan:\n" + "\n".join(f"{i+1}. {s}" for i, s in enumerate(plan.get("steps", [])))
            if plan else context
        )
        return f"Goal: {goal}\n\n{plan_text}\n\nProvide a research summary to inform implementation."

    def parse_output(self, raw: str, blackboard: Blackboard) -> None:
        blackboard.append_note(self.name, raw.strip())
        blackboard.set_artifact("research_summary", raw.strip())
