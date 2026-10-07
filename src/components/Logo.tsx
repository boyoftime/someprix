import icon from "../assets/someprix-icon.png";

type LogoProps = {
  size?: number;
  className?: string;
};

/** The app icon: the same picture as the window, taskbar and installer. */
export function Logo({ size = 24, className }: LogoProps) {
  return <img src={icon} width={size} height={size} className={className} alt="" draggable={false} />;
}
