import { useEffect, useRef } from "react";
import lottie from "lottie-web/build/player/lottie_light";

type LottieProps = {
  /** The animation's JSON (a Lottie export). */
  data: object;
  size: number;
  className?: string;
};

/**
 * Plays a Lottie animation on a loop. With reduced motion it shows a single still frame.
 * Decorative: always paired with visible text that says what is happening.
 */
export function Lottie({ data, size, className }: LottieProps) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!box.current) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animation = lottie.loadAnimation({
      container: box.current,
      renderer: "svg",
      loop: true,
      autoplay: !still,
      animationData: data,
      rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
    });
    if (still) animation.goToAndStop(animation.totalFrames / 2, true);
    return () => animation.destroy();
  }, [data]);

  return <div ref={box} className={className} style={{ width: size, height: size }} aria-hidden="true" />;
}
