"""Tests for the documented qdag command surface.

Test classes:
    - TestCommandSurface: required command groups and backup/run commands.
"""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

import qdag.cli as cli_module
from qdag.cli import app
from qdag.endpoints import experiment, run_complete
from qdag.runner import RunOptions, RunOutcome


class TestCommandSurface:
    """Expose all required lifecycle commands from one stable entry point."""

    def test_root_help_lists_required_commands(self) -> None:
        result = CliRunner().invoke(app, ["--help"])

        assert result.exit_code == 0
        for command in (
            "auth",
            "spaces",
            "experiments",
            "lineage",
            "semantic",
            "run",
            "backup",
            "restore",
        ):
            assert command in result.stdout

    def test_resource_help_lists_lifecycle_actions(self) -> None:
        runner = CliRunner()

        assert "login" in runner.invoke(app, ["auth", "--help"]).stdout
        assert "logout" in runner.invoke(app, ["auth", "--help"]).stdout
        experiments_help = runner.invoke(app, ["experiments", "--help"]).stdout
        assert "create" in experiments_help
        assert "show" in experiments_help
        assert "finalize" in experiments_help

    def test_endpoint_builders_quote_untrusted_segments(self) -> None:
        assert experiment("id/with slash") == "/api/v1/experiments/id%2Fwith%20slash"
        assert run_complete("run/1") == "/api/v1/runs/run%2F1/complete"

    def test_run_accepts_child_command_after_double_dash(
        self,
        tmp_path: Path,
        monkeypatch,
    ) -> None:
        captured: list[RunOptions] = []

        class ClientContext:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        class Executor:
            def __init__(self, _client: object) -> None:
                pass

            def execute(self, options: RunOptions) -> RunOutcome:
                captured.append(options)
                return RunOutcome(
                    run_id="run-1",
                    exit_code=0,
                    synchronized=True,
                    log_path=tmp_path / "run.log",
                    log_truncated=False,
                )

        monkeypatch.setattr(cli_module, "_build_client", ClientContext)
        monkeypatch.setattr(cli_module, "RunExecutor", Executor)

        result = CliRunner().invoke(
            app,
            [
                "run",
                "--experiment",
                "experiment-1",
                "--result",
                "result.json",
                "--",
                "python",
                "-c",
                "print('ok')",
            ],
        )

        assert result.exit_code == 0
        assert captured[0].command == ["python", "-c", "print('ok')"]
