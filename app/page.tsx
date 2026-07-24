import { ControlTower } from "./ControlTower";
import seed from "./data/seed.json";

export default function Home() {
  return <ControlTower seed={seed} />;
}
