type AuthHeroProps = {
  eyebrow?: string;
  title?: string;
  description?: string;
};

export default function AuthHero({
  eyebrow = "PinHaoYun",
  title = "上网买拼多多，\n外卖点拼好饭\n视频用拼好云，\n人生就是要拼。",
  description = "拼好云使用AWS无服务器架构，让您绝对不为服务器多花一分钱。",
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
