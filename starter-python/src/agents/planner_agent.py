from src.core.base_agent import BaseAgent
from src.core.blackboard import Blackboard


class PlannerAgent(BaseAgent):
    def __init__(self):
        super().__init__("Planner")

    def system_prompt(self) -> str:
        return """You are a planning agent. Given a goal, produce a concise structured plan.

Output a JSON object with this exact shape:
{
  "objective": "one-sentence restatement of the goal",
  "steps": ["step 1", "step 2", "step 3"],
  "constraints": ["constraint 1", "constraint 2"],
  "success_criteria": "how to know when done"
}

Output ONLY the JSON. No explanation before or after."""

    def build_prompt(self, goal: str, context: str, blackboard: Blackboard) -> str:
        return f"Goal: {goal}\n\nCreate a structured plan."

    def parse_output(self, raw: str, blackboard: Blackboard) -> None:
        plan = self.clean_json(raw)
        if plan:
            blackboard.set_artifact("plan", plan)
            steps = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(plan.get("steps", [])))
            blackboard.append_note(
                self.name,
                f"Objective: {plan.get('objective', '')}\n"
                f"Steps:\n{steps}\n"
                f"Success: {plan.get('success_criteria', '')}",
            )
        else:
            blackboard.append_note(self.name, raw.strip())
