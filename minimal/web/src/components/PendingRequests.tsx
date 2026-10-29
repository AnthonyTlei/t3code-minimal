import { useState } from "react";
import { ShieldQuestionIcon, MessageCircleQuestionIcon } from "lucide-react";
import type { PendingRequest } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function readable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) || "";
}

type Question = { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; isSecret?: boolean };

function QuestionForm({ questions, submit, disabled }: { questions: Question[]; submit: (result: unknown) => void; disabled: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return <form onSubmit={event => { event.preventDefault(); submit({ answers: Object.fromEntries(questions.map(question => [question.id, { answers: [answers[question.id].trim()] }])) }); }}>
    {questions.map(question => <fieldset key={question.id} className="question-field"><legend>{question.header || question.question}</legend>{question.header && <p>{question.question}</p>}
      {question.options?.map(option => <label className="question-option" key={option.label}><input type="radio" name={question.id} checked={answers[question.id] === option.label} onChange={() => setAnswers(current => ({ ...current, [question.id]: option.label }))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
      <Input type={question.isSecret ? "password" : "text"} aria-label={`Answer: ${question.question}`} placeholder={question.options?.length ? "Or enter an answer…" : "Your answer…"} value={answers[question.id] || ""} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} />
    </fieldset>)}
    <Button size="sm" disabled={disabled || questions.some(question => !answers[question.id]?.trim())} type="submit">Send answers</Button>
  </form>;
}

function decisionLabel(decision: unknown) {
  const name = typeof decision === "string" ? decision : decision && typeof decision === "object" ? Object.keys(decision)[0] : "";
  const labels: Record<string, string> = { accept: "Approve once", decline: "Decline", cancel: "Cancel request" };
  return labels[name || ""] || (name || "Decision").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function PendingRequests({ requests, respond, disabled }: { requests: PendingRequest[]; respond: (requestId: string | number, result: unknown) => void; disabled: boolean }) {
  return <div className="pending-requests">{requests.map((request, index) => {
    const params = request.params || {};
    const questions = Array.isArray(params.questions) ? params.questions as Question[] : [];
    const id = request.requestId ?? request.id;
    const decisions = (request.allowedDecisions || []).filter(decision => typeof decision === "string" && ["accept", "decline", "cancel"].includes(decision));
    const detail = params.command ?? params.reason ?? params.message ?? params.changes ?? params;
    return <section className="request-card" key={String(id ?? index)} aria-label={questions.length ? "Agent question" : "Approval requested"}>
      <div className="request-title">{questions.length ? <MessageCircleQuestionIcon /> : <ShieldQuestionIcon />}<strong>{questions.length ? "Codex needs your input" : "Approval requested"}</strong></div>
      {questions.length ? <QuestionForm questions={questions} disabled={disabled || id === undefined} submit={result => { if (id !== undefined) respond(id, result); }} /> : <>
        <pre className="request-detail">{readable(detail)}</pre>
        {params.command !== undefined && params.reason !== undefined && <p className="request-context">Reason: {readable(params.reason)}</p>}
        {params.cwd !== undefined && <p className="request-context">Working directory: {readable(params.cwd)}</p>}
        <details className="request-context"><summary>Native request details</summary><pre className="request-detail">{readable(params)}</pre></details>
        <div className="request-decisions">{decisions.map((decision, n) => <Button size="sm" variant={/decline|denied|cancel/.test(readable(decision)) ? "outline" : "default"} disabled={disabled || id === undefined} key={n} onClick={() => { if (id !== undefined) respond(id, { decision }); }}>{decisionLabel(decision)}</Button>)}</div>
        {!decisions.length && <p className="muted">This request has no supported decisions. Cancel the turn if it cannot continue.</p>}
      </>}
    </section>;
  })}</div>;
}
