import type { Submission } from "@/lib/mock-data";

interface SubmissionHistoryProps {
  submissions: Submission[];
  onLoadSubmission?: (sourceCode: string, language: string) => void;
}

export default function SubmissionHistory({ submissions, onLoadSubmission }: SubmissionHistoryProps) {
  return (
    <div className="p-4">
      {submissions.length === 0 ? (
        <p className="text-sm text-ink-3 text-center py-8">
          No submissions yet
        </p>
      ) : (
        <div className="space-y-2">
          {submissions.map((submission) => {
            const canLoad = !!submission.sourceCode && !!onLoadSubmission;

            return (
              <div
                key={submission.id}
                onClick={() => {
                  if (canLoad) {
                    onLoadSubmission!(submission.sourceCode!, submission.language);
                  }
                }}
                className={`flex items-center justify-between p-3 rounded-lg bg-ide-code/50 transition-colors ${
                  canLoad
                    ? "hover:bg-ide-raised cursor-pointer"
                    : "hover:bg-ide-code"
                }`}
                title={canLoad ? "Click to load this code into the editor" : undefined}
              >
                <div className="flex items-center gap-3">
                  {/* Status icon */}
                  {submission.status === "Accepted" ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <circle cx="8" cy="8" r="7.5" stroke="currentColor" />
                      <path
                        d="M4 8.22485L6.50511 10.6864L10.6978 4.57151"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                  ) : (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <circle cx="8" cy="8" r="7.5" stroke="currentColor" />
                      <path
                        d="M7.8927 6.6814L9.91418 4.66089L11.1261 5.87378L9.10559 7.89331L11.0363 9.82495L9.82434 11.0369L7.89368 9.1062L5.87317 11.1267L4.66125 9.91382L6.68079 7.89331L4.57141 5.78394L5.7843 4.57202L7.8927 6.6814Z"
                        fill="currentColor"
                      />
                    </svg>
                  )}

                  <div>
                    <p
                      className={`text-sm font-medium ${
                        submission.status === "Accepted"
                          ? "text-ink-2"
                          : submission.status === "Wrong Answer"
                            ? "text-ink-2"
                            : "text-ink-3"
                      }`}
                    >
                      {submission.status}
                    </p>
                    {submission.passedTests !== undefined && submission.totalTests !== undefined && (
                      <p className="text-xs text-ink-3">
                        {submission.passedTests}/{submission.totalTests} test cases passed
                      </p>
                    )}
                    <p className="text-xs text-ink-3">{submission.timestamp}</p>
                  </div>
                </div>

                <div className="text-right">
                  <p className="text-xs text-ink-2">{submission.runtime}</p>
                  <p className="text-xs text-ink-3">{submission.language}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
