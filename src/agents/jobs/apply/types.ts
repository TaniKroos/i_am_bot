export type FieldType = "text" | "textarea" | "file" | "select" | "multiselect" | "checkbox" | "hidden";

export interface FieldOption {
  label: string;
  value: string;
}

/** One question on an application form, normalised across careers systems. */
export interface FormField {
  /** The form's own field name/id, used by the filler to find it. */
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: FieldOption[];
  /** e.g. "eeoc" for voluntary demographic questions. */
  group?: string;
}

export type AnswerSource = "profile" | "answer_bank" | "rule" | "eeo_decline" | "resume" | "consent" | "composed";

export type Answer =
  | { kind: "value"; value: string | string[]; source: AnswerSource; note?: string }
  | { kind: "skip"; reason: string }
  /** Required and unanswerable from what we know: the owner must answer once. */
  | { kind: "ask"; question: string };

export interface PlannedField {
  field: FormField;
  answer: Answer;
}

export interface ApplicationPlan {
  jobId: string;
  fields: PlannedField[];
  /** Required questions the owner must answer before this application can proceed. */
  blockers: string[];
}
