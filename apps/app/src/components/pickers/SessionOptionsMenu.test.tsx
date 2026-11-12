// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ThreadSessionOption } from "@bb/domain";
import type { ThreadTimelineSessionOption } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionOptionsMenu,
  buildSessionOptionMenuSections,
  declaredSessionOptionViews,
  sessionOptionViewSelections,
  sessionOptionsTriggerLabel,
  splitSessionOptionsByPlacement,
  type SessionOptionChoices,
} from "./SessionOptionsMenu";

const mode: ThreadTimelineSessionOption = {
  type: "select",
  id: "mode",
  label: "Mode",
  description: "How the agent works",
  category: "mode",
  sticky: false,
  value: "agent",
  pendingValue: null,
  chosenValue: null,
  values: [
    { id: "agent", label: "Agent", description: null, group: null },
    { id: "plan", label: "Plan", description: "Read only", group: null },
  ],
};
const web: ThreadTimelineSessionOption = {
  type: "boolean",
  id: "web",
  label: "Web search",
  description: null,
  category: null,
  sticky: false,
  value: false,
  pendingValue: null,
  chosenValue: null,
};
const ultracode: ThreadTimelineSessionOption = {
  type: "boolean",
  id: "ultracode",
  label: "Ultracode",
  description: null,
  category: null,
  sticky: true,
  value: true,
  pendingValue: null,
  chosenValue: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("session option placement", () => {
  it("keeps only the mode option in the footer", () => {
    const placed = splitSessionOptionsByPlacement([web, mode]);
    expect(placed.footer.map((option) => option.id)).toEqual(["mode"]);
    expect(placed.picker.map((option) => option.id)).toEqual(["web"]);
  });

  it("reads the value each option will have on the next turn", () => {
    expect(
      sessionOptionViewSelections(
        [{ ...mode, pendingValue: "plan", chosenValue: "plan" }, web],
        { web: true },
      ),
    ).toEqual({ mode: "plan", web: true });
  });

  it("reads a sticky option only from a stored or local choice", () => {
    expect(
      sessionOptionViewSelections(
        [ultracode, { ...ultracode, id: "kept", chosenValue: true }],
        {},
      ),
    ).toEqual({ kept: true });
    expect(
      sessionOptionViewSelections([ultracode], { ultracode: false }),
    ).toEqual({ ultracode: false });
  });
});

describe("declared session option views", () => {
  const declaredDaybreak: ThreadSessionOption = {
    type: "boolean",
    id: "daybreak",
    label: "Daybreak",
    value: false,
  };
  const declaredDepth: ThreadSessionOption = {
    type: "select",
    id: "depth",
    label: "Search depth",
    value: "shallow",
    values: [
      { id: "shallow", label: "Shallow" },
      { id: "deep", label: "Deep" },
    ],
  };

  it("shows what the user chose before the thread exists", () => {
    expect(
      declaredSessionOptionViews(
        [declaredDaybreak, declaredDepth],
        { daybreak: true, depth: "deep" },
        [],
      ).map((option) => [option.id, option.value, option.pendingValue]),
    ).toEqual([
      ["daybreak", true, null],
      ["depth", "deep", null],
    ]);
  });

  it("shows the selected model's own value for an option the user has not touched", () => {
    expect(
      declaredSessionOptionViews([declaredDaybreak, declaredDepth], {}, [
        { ...declaredDaybreak, value: true, fixed: true },
        { ...declaredDepth, value: "deep" },
      ]).map((option) => [option.id, option.value]),
    ).toEqual([
      ["daybreak", true],
      ["depth", "deep"],
    ]);
  });

  it("ignores a stored choice of the wrong kind", () => {
    expect(
      declaredSessionOptionViews([declaredDaybreak], { daybreak: "yes" }, [])[0]
        ?.value,
    ).toBe(false);
  });

  it("shows a sticky option at the choice, else the selected model's default, else not at all", () => {
    const declaredUltracode: ThreadSessionOption = {
      type: "boolean",
      id: "ultracode",
      label: "Ultracode",
      value: true,
      experimental_sticky: true,
    };
    const shown = (
      selections: SessionOptionChoices,
      activeModelOptions: ThreadSessionOption[],
    ) =>
      buildSessionOptionMenuSections(
        declaredSessionOptionViews(
          [declaredUltracode],
          selections,
          activeModelOptions,
        ),
        selections,
        activeModelOptions,
      ).map((section) => [section.selectedLabel, section.appliesOnNextTurn]);
    expect(shown({ ultracode: true }, [])).toEqual([["On", false]]);
    expect(shown({}, [{ ...declaredUltracode, value: false }])).toEqual([
      ["Off", false],
    ]);
    expect(shown({}, [])).toEqual([]);
  });
});

describe("session option menu sections", () => {
  it("shows the local choice first, then the server's stored choice, then the agent's value", () => {
    const pendingMode = { ...mode, pendingValue: "plan", chosenValue: "plan" };
    expect(
      buildSessionOptionMenuSections([mode], {}, []).map((section) => [
        section.selectedLabel,
        section.appliesOnNextTurn,
      ]),
    ).toEqual([["Agent", false]]);
    expect(
      buildSessionOptionMenuSections([pendingMode], {}, []).map((section) => [
        section.selectedLabel,
        section.appliesOnNextTurn,
      ]),
    ).toEqual([["Plan", true]]);
    expect(
      buildSessionOptionMenuSections([pendingMode], { mode: "agent" }, []).map(
        (section) => [section.selectedLabel, section.appliesOnNextTurn],
      ),
    ).toEqual([["Agent", false]]);
  });

  it("shows a sticky option's stored choice, else the model's default, and never the value the agent reports", () => {
    const shown = (option: ThreadTimelineSessionOption) =>
      buildSessionOptionMenuSections([option], {}, [
        { type: "boolean", id: "ultracode", label: "Ultracode", value: false },
      ]).map((section) => [section.selectedLabel, section.appliesOnNextTurn]);
    expect(shown(ultracode)).toEqual([["Off", true]]);
    expect(shown({ ...ultracode, chosenValue: true })).toEqual([["On", false]]);
    expect(shown({ ...ultracode, sticky: false })).toEqual([["On", false]]);
    expect(buildSessionOptionMenuSections([ultracode], {}, [])).toEqual([]);
  });

  it("names the trigger after the agent's mode, a lone option, or nothing in particular", () => {
    const label = (options: ThreadTimelineSessionOption[]) =>
      sessionOptionsTriggerLabel(
        buildSessionOptionMenuSections(options, {}, []),
      );
    expect(label([web, mode])).toBe("Agent");
    expect(label([web])).toBe("Web search: Off");
    expect(label([web, { ...web, id: "brave", label: "Brave" }])).toBe(
      "Options",
    );
  });
});

describe("SessionOptionsMenu", () => {
  it.each([
    ["the agent reports no options", []],
    ["every option is left out", [ultracode]],
  ])("renders nothing when %s", (_case, options) => {
    const { container } = render(
      <SessionOptionsMenu
        options={options}
        choices={{}}
        modelOptions={[]}
        onChange={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("reports a select choice by value id and a boolean choice as a boolean", async () => {
    const onChange = vi.fn();
    render(
      <SessionOptionsMenu
        options={[mode, web]}
        choices={{}}
        modelOptions={[]}
        onChange={onChange}
      />,
    );
    const open = () =>
      fireEvent.keyDown(screen.getByRole("button", { name: "Agent options" }), {
        key: "Enter",
      });

    open();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Plan/ }));
    expect(onChange).toHaveBeenLastCalledWith("mode", "plan");

    open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "On" }));
    expect(onChange).toHaveBeenLastCalledWith("web", true);
  });
});
