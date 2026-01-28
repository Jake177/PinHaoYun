type AuthHeroProps = {
  eyebrow?: string;
  title?: string;
  description?: string;
};

export default function AuthHero({
  eyebrow = "PinHaoYun",
  title = "Your personal cloud library.",
  description = "Powered by AWS cloud services.",
}: AuthHeroProps) {
  const titleLines = title
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <section className="auth-hero">
      <div className="auth-hero__content">
        {eyebrow ? <p className="auth-hero__eyebrow">{eyebrow}</p> : null}
        <h1 className="auth-hero__title">
          {titleLines.map((line, index) => (
            <span className="auth-hero__line" key={`${line}-${index}`}>
              {line}
            </span>
          ))}
        </h1>
        <p className="auth-hero__subtitle">{description}</p>
      </div>
    </section>
  );
}
