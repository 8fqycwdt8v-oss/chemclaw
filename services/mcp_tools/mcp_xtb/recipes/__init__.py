"""xtb workflow recipes.

Each recipe is a ``Workflow`` (see ``services.mcp_tools.mcp_xtb.workflow``)
exported as a ``WORKFLOW`` constant from a single file. The registry below
is what ``/run_workflow`` resolves against — adding a new recipe means
creating a new module in this package and importing it here.
"""

from __future__ import annotations

from services.mcp_tools.mcp_xtb.recipes import (
    optimize_ensemble,
    reaction_energy,
)
from services.mcp_tools.mcp_xtb.workflow import Workflow

RECIPES: dict[str, Workflow] = {
    optimize_ensemble.WORKFLOW.name: optimize_ensemble.WORKFLOW,
    reaction_energy.WORKFLOW.name: reaction_energy.WORKFLOW,
}

__all__ = ["RECIPES"]
