import { getJson } from "../sources/http.js";
import type { FieldType, FormField } from "./types.js";

interface GhField {
  name: string;
  type: string;
  values?: { label: string; value: number | string }[];
}
interface GhQuestion {
  label: string;
  required: boolean;
  fields: GhField[];
}

const TYPES: Record<string, FieldType> = {
  input_text: "text",
  textarea: "textarea",
  input_file: "file",
  input_hidden: "hidden",
  multi_value_single_select: "select",
  multi_value_multi_select: "multiselect",
};

function toFields(q: GhQuestion, group?: string): FormField[] {
  return q.fields.map((f) => ({
    key: f.name,
    label: q.label,
    type: TYPES[f.type] ?? "text",
    required: q.required,
    options: f.values?.map((v) => ({ label: v.label, value: String(v.value) })),
    group,
  }));
}

/** Greenhouse publishes every application question (names, types, options) on its public job board API. */
export async function greenhouseForm(boardToken: string, jobId: string): Promise<FormField[]> {
  const d = await getJson<{
    questions?: GhQuestion[];
    location_questions?: GhQuestion[];
    compliance?: { type: string; questions: GhQuestion[] }[];
  }>(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs/${jobId}?questions=true`);
  return [
    ...(d.questions ?? []).flatMap((q) => toFields(q)),
    ...(d.location_questions ?? []).flatMap((q) => toFields(q, "location")),
    ...(d.compliance ?? []).flatMap((c) => c.questions.flatMap((q) => toFields(q, c.type))),
  ];
}
