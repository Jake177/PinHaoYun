type AuthHeroProps = {
  eyebrow?: string;
  title?: string;
  description?: string;
};

export default function AuthHero({
  eyebrow = "PinHaoYun",
  title = "与 AWS Cognito 完成闭环",
  description = "使用托管的用户池保证安全合规，现有页面直接调用 Cognito 完成注册、验证与登录，满足企业级密码与属性规范。",
}: AuthHeroProps) {
  return (
    <section className="auth-hero">
      <div className="auth-hero__content">
        {eyebrow ? <p className="auth-hero__eyebrow">{eyebrow}</p> : null}
        <h1 className="auth-hero__title">{title}</h1>
        <p className="auth-hero__subtitle">{description}</p>
      </div>
    </section>
  );
}
