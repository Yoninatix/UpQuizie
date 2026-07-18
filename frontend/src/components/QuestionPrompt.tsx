export const QUESTION_IMAGE_TOKEN = "[[question_image]]";

interface QuestionPromptProps {
  prompt: unknown;
  imageUrl?: string | null;
  className?: string;
  imageClassName?: string;
  imageWrapperClassName?: string;
}

function toPromptText(prompt: unknown): string {
  if (prompt == null) return "";
  if (typeof prompt === "string") return prompt;
  if (typeof prompt === "number" || typeof prompt === "boolean") return String(prompt);
  try { return JSON.stringify(prompt); } catch { return String(prompt); }
}

export function promptHasInlineImage(prompt: unknown) {
  return toPromptText(prompt).includes(QUESTION_IMAGE_TOKEN);
}

export function insertQuestionImageToken(prompt: unknown, start?: number | null, end?: number | null) {
  const text = toPromptText(prompt);
  if (promptHasInlineImage(text)) return text;
  const token = `\n${QUESTION_IMAGE_TOKEN}\n`;
  if (typeof start === "number" && typeof end === "number") {
    return `${text.slice(0, start)}${token}${text.slice(end)}`;
  }
  return `${text.trimEnd()}${text.trim() ? "\n" : ""}${QUESTION_IMAGE_TOKEN}`;
}

export default function QuestionPrompt({
  prompt,
  imageUrl,
  className = "",
  imageClassName = "max-h-72 w-full rounded-md object-contain",
  imageWrapperClassName = "my-4 rounded-lg border border-outline-variant bg-surface-container-low p-2",
}: QuestionPromptProps) {
  const text = toPromptText(prompt);
  const parts = text.split(QUESTION_IMAGE_TOKEN);
  const hasInline = imageUrl && parts.length > 1;

  return (
    <div className={className}>
      {parts.map((part, index) => (
        <FragmentBlock
          key={index}
          text={part}
          showImage={Boolean(hasInline && index < parts.length - 1)}
          imageUrl={imageUrl}
          imageClassName={imageClassName}
          imageWrapperClassName={imageWrapperClassName}
        />
      ))}
      {imageUrl && !hasInline && (
        <QuestionImage imageUrl={imageUrl} imageClassName={imageClassName} imageWrapperClassName={imageWrapperClassName} />
      )}
    </div>
  );
}

function FragmentBlock({
  text,
  showImage,
  imageUrl,
  imageClassName,
  imageWrapperClassName,
}: {
  text: string;
  showImage: boolean;
  imageUrl?: string | null;
  imageClassName: string;
  imageWrapperClassName: string;
}) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (
    <>
      {lines.map((line, index) => <p key={index}>{line}</p>)}
      {showImage && imageUrl && (
        <QuestionImage imageUrl={imageUrl} imageClassName={imageClassName} imageWrapperClassName={imageWrapperClassName} />
      )}
    </>
  );
}

function QuestionImage({
  imageUrl,
  imageClassName,
  imageWrapperClassName,
}: {
  imageUrl: string;
  imageClassName: string;
  imageWrapperClassName: string;
}) {
  return (
    <div className={imageWrapperClassName}>
      <img src={imageUrl} alt="Question diagram" className={imageClassName} />
    </div>
  );
}
