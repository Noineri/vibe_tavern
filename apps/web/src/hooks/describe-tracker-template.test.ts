import { describe, expect, it } from "bun:test";
import i18next from "i18next";
import {
  defaultObjectiveState,
  normalizeTrackerTemplate,
  type TrackerTemplate,
} from "@vibe-tavern/domain";
import en from "../i18n/locales/en.json";
import ru from "../i18n/locales/ru.json";
import { describeTrackerTemplate } from "./describe-tracker-template.js";

function makeTemplate({ sceneFieldCount = 0, objectiveMode, objectiveCount = 0 }: {
  sceneFieldCount?: number;
  objectiveMode?: "route" | "goals";
  objectiveCount?: number;
}): TrackerTemplate {
  const objectiveState = defaultObjectiveState();
  const template = normalizeTrackerTemplate({
    version: 1,
    scene: sceneFieldCount > 0
      ? {
          enabled: true,
          config: {
            schema: Object.fromEntries(
              Array.from({ length: sceneFieldCount }, (_, index) => [`field_${index}`, { $type: "string" }]),
            ),
          },
        }
      : null,
    objective: objectiveMode
      ? {
          enabled: true,
          state: {
            ...objectiveState,
            mode: objectiveMode,
            tasks: objectiveMode === "route"
              ? Array.from({ length: objectiveCount }, (_, index) => ({
                  id: `task_${index}`,
                  description: `Task ${index}`,
                  status: "pending",
                }))
              : [],
            shortTermGoals: objectiveMode === "goals"
              ? Array.from({ length: objectiveCount }, (_, index) => ({
                  id: `goal_${index}`,
                  description: `Goal ${index}`,
                  status: "pending",
                }))
              : [],
          },
        }
      : null,
  });
  if (!template) throw new Error("Expected a populated tracker template");
  return template;
}

async function makeTranslator(locale: "en" | "ru") {
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    resources: { en: { translation: en }, ru: { translation: ru } },
    keySeparator: false,
    nsSeparator: false,
    interpolation: { prefix: "{", suffix: "}" },
    pluralSeparator: "_",
  });
  return (key: string, opts?: Record<string, unknown>) => String(instance.t(key, opts));
}

describe("describeTrackerTemplate", () => {
  it("omits absent scene or objective parts", async () => {
    const t = await makeTranslator("en");

    expect(describeTrackerTemplate(makeTemplate({ sceneFieldCount: 2 }), t)).toBe("Scene: 2 fields");
    expect(describeTrackerTemplate(makeTemplate({ objectiveMode: "route", objectiveCount: 3 }), t))
      .toBe("Objectives: route mode, 3 goals");
  });

  it("uses Russian CLDR forms for one, few, and many scene fields", async () => {
    const t = await makeTranslator("ru");

    expect(describeTrackerTemplate(makeTemplate({ sceneFieldCount: 1 }), t)).toBe("Сцена: 1 поле");
    expect(describeTrackerTemplate(makeTemplate({ sceneFieldCount: 2 }), t)).toBe("Сцена: 2 поля");
    expect(describeTrackerTemplate(makeTemplate({ sceneFieldCount: 5 }), t)).toBe("Сцена: 5 полей");
  });

  it("uses the mode-specific objective count and Russian CLDR goal forms", async () => {
    const t = await makeTranslator("ru");

    expect(describeTrackerTemplate(makeTemplate({ objectiveMode: "route", objectiveCount: 1 }), t))
      .toBe("Цели: режим «маршрут», 1 цель");
    expect(describeTrackerTemplate(makeTemplate({ objectiveMode: "goals", objectiveCount: 2 }), t))
      .toBe("Цели: режим «цели», 2 цели");
    expect(describeTrackerTemplate(makeTemplate({ objectiveMode: "goals", objectiveCount: 5 }), t))
      .toBe("Цели: режим «цели», 5 целей");
  });

  it("joins the two present parts in the mockup order", async () => {
    const t = await makeTranslator("en");

    expect(describeTrackerTemplate(makeTemplate({ sceneFieldCount: 7, objectiveMode: "goals", objectiveCount: 3 }), t))
      .toBe("Scene: 7 fields · Objectives: goals mode, 3 goals");
  });
});
