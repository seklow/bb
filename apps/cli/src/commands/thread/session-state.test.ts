import { describe, expect, it } from "vitest";
import {
  formatThreadProviderCommands,
  formatThreadSessionOptions,
  parseSessionOptionAssignments,
  parseSpawnSessionOptions,
} from "./session-state.js";

describe("thread session state output", () => {
  it("lists agent commands with their argument hint and description", () => {
    expect(
      formatThreadProviderCommands([
        {
          name: "web",
          source: "command",
          origin: "builtin",
          description: "Search the web",
          argumentHint: "query",
        },
        {
          name: "compact",
          source: "command",
          origin: "builtin",
          description: null,
          argumentHint: null,
        },
      ]),
    ).toEqual(["/web <query>  Search the web", "/compact"]);
    expect(formatThreadProviderCommands(null)).toEqual([
      "The agent has not advertised any commands for this thread.",
    ]);
  });

  it("lists session options, marking the current value of a select and a sticky option's stored choice", () => {
    expect(
      formatThreadSessionOptions([
        {
          type: "select",
          id: "mode",
          label: "Mode",
          description: null,
          category: "mode",
          sticky: false,
          value: "plan",
          pendingValue: "build",
          chosenValue: "build",
          values: [
            { id: "plan", label: "Plan", description: null, group: null },
            { id: "build", label: "build", description: null, group: null },
          ],
        },
        {
          type: "boolean",
          id: "brave",
          label: "Brave mode",
          description: null,
          category: null,
          sticky: false,
          value: true,
          pendingValue: null,
          chosenValue: null,
        },
        {
          type: "boolean",
          id: "ultracode",
          label: "Ultracode",
          description: null,
          category: null,
          sticky: true,
          value: true,
          pendingValue: false,
          chosenValue: false,
        },
      ]),
    ).toEqual([
      "mode (Mode): plan -> build on the next turn",
      "  * plan  Plan",
      "    build",
      "brave (Brave mode): true",
      "ultracode (Ultracode): true (your choice: false)",
    ]);
    expect(formatThreadSessionOptions([])).toEqual([
      "The agent has no session options available right now.",
    ]);
    expect(formatThreadSessionOptions(null)).toEqual([
      "The agent has not reported any session options for this thread.",
    ]);
  });

  it("turns --set and --clear into a patch, reading true and false for a boolean option", () => {
    const options = [
      {
        type: "boolean" as const,
        id: "web",
        label: "Web search",
        description: null,
        category: null,
        sticky: false,
        value: false,
        pendingValue: null,
        chosenValue: null,
      },
    ];
    expect(
      parseSessionOptionAssignments({
        options,
        set: ["web=true", "mode=plan=strict"],
        clear: ["brave"],
      }),
    ).toEqual({ web: true, mode: "plan=strict", brave: null });
    expect(() =>
      parseSessionOptionAssignments({ options, set: ["web=yes"], clear: [] }),
    ).toThrow("takes true or false");
    expect(() =>
      parseSessionOptionAssignments({ options, set: ["=plan"], clear: [] }),
    ).toThrow("Expected <option-id>=<value>");
    expect(() =>
      parseSessionOptionAssignments({
        options,
        set: ["web=true"],
        clear: ["web"],
      }),
    ).toThrow("cannot be both set and cleared");
  });

  it("turns spawn --option assignments into choices, reading true and false as on and off", () => {
    expect(
      parseSpawnSessionOptions(["daybreak=true", "web=false", "mode=plan=x"]),
    ).toEqual({ daybreak: true, web: false, mode: "plan=x" });
    expect(parseSpawnSessionOptions([])).toEqual({});
    expect(() => parseSpawnSessionOptions(["daybreak"])).toThrow(
      "Expected <option-id>=<value>",
    );
    expect(() => parseSpawnSessionOptions(["mode="])).toThrow(
      "Expected <option-id>=<value>",
    );
  });
});
