type AuthHeadingProps = {
  title: string;
  description: string;
};

export default function AuthHeading({
  title,
  description,
}: AuthHeadingProps) {
  return (
    <div className="auth-heading">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
