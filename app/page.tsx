import { ControlTower } from "./ControlTower";
import productionPlan from "./data/production-plan.json";
import productionSignals from "./data/production-signals.json";
import seed from "./data/seed.json";

export default function Home() {
  return (
    <ControlTower
      seed={seed}
      productionPlan={productionPlan}
      productionSignals={productionSignals}
    />
  );
}
