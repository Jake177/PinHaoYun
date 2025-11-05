import Image from "next/image";

type LogoProps = {
  className?: string;
};

export default function Logo({ className }: LogoProps) {
  const classes = ["site-logo", className].filter(Boolean).join(" ");
  return (
    <span className={classes}>
      <span className="site-logo__mark" aria-hidden="true">
        <Image src="/logo.svg" alt="" width={48} height={72} priority />
      </span>
      <span className="site-logo__text">PinHaoYun</span>
    </span>
  );
}
