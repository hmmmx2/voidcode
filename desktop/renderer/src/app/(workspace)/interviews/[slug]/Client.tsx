"use client";

import { usePathname } from "next/navigation";
import QuestionRouter from "@/components/Interviews/QuestionRouter";

export default function InterviewQuestionClient() {
  const slug = usePathname().split("/").filter(Boolean).pop() ?? "";
  // QuestionRouter picks the IDE or the written workspace, because which one a question
  // needs is a property of the question rather than of the URL.
  return <QuestionRouter slug={slug} />;
}
