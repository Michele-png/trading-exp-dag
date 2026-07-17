import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState, ErrorState } from "@/components/ui-states";

describe("UI states", () => {
  it("renders an accessible empty state", () => {
    render(
      <EmptyState
        description="Create the first experiment."
        title="No nodes yet"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "No nodes yet" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("empty-state")).toHaveTextContent(
      "Create the first experiment.",
    );
  });

  it("announces errors without exposing implementation detail", () => {
    render(
      <ErrorState
        description="Try the request again."
        title="Dashboard unavailable"
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Dashboard unavailable");
    expect(alert).toHaveTextContent("Try the request again.");
  });
});
