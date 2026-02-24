import { HeroSection } from '@/components/sections/hero';
import { WhySection } from '@/components/sections/why';
import { HowItWorksSection } from '@/components/sections/how-it-works';
import { FeaturesSection } from '@/components/sections/features';
import { MultiMachineSection } from '@/components/sections/multi-machine';
import { InstallationSection } from '@/components/sections/installation';

export function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
      <HeroSection />
      <WhySection />
      <HowItWorksSection />
      <FeaturesSection />
      <MultiMachineSection />
      <InstallationSection />
    </div>
  );
}
