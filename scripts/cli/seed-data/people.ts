// Fictional staff for the demo projects. They have no credential account, so
// none of them can sign in; they only make the issue tracker, deploy history
// and knowledge base look lived-in.
import type { WorkingHours } from "@/lib/user-display";

export type StaffHandle =
  | "ayu"
  | "bima"
  | "citra"
  | "dimas"
  | "eka"
  | "fajar"
  | "gita"
  | "hadi"
  | "intan"
  | "joko";

export interface DemoStaff {
  handle: StaffHandle;
  name: string;
  // Email local part; the domain is DEMO_EMAIL_DOMAIN.
  login: string;
  orgRole: "engineer" | "qa" | "observer" | "infra";
  title: string;
  // Project keys the person is a member of (engineers and QA only see
  // these).
  projects: readonly string[];
}

export const DEMO_STAFF: readonly DemoStaff[] = [
  {
    handle: "ayu",
    name: "Ayu Lestari",
    login: "ayu.lestari",
    orgRole: "engineer",
    title: "Backend Engineer",
    projects: ["NPMB", "NPCP"],
  },
  {
    handle: "bima",
    name: "Bima Pratama",
    login: "bima.pratama",
    orgRole: "engineer",
    title: "Backend Engineer",
    projects: ["NPMB", "BSAC"],
  },
  {
    handle: "citra",
    name: "Citra Wulandari",
    login: "citra.wulandari",
    orgRole: "qa",
    title: "QA Engineer",
    projects: ["NPMB", "NPCP"],
  },
  {
    handle: "dimas",
    name: "Dimas Saputra",
    login: "dimas.saputra",
    orgRole: "engineer",
    title: "Frontend Engineer",
    projects: ["NPCP"],
  },
  {
    handle: "eka",
    name: "Eka Rahmawati",
    login: "eka.rahmawati",
    orgRole: "qa",
    title: "QA Engineer",
    projects: ["BSAC"],
  },
  {
    handle: "fajar",
    name: "Fajar Nugroho",
    login: "fajar.nugroho",
    orgRole: "engineer",
    title: "Tech Lead",
    projects: ["NPMB", "NPCP", "BSAC"],
  },
  {
    handle: "gita",
    name: "Gita Permata",
    login: "gita.permata",
    orgRole: "qa",
    title: "QA Lead",
    projects: ["NPMB", "NPCP", "BSAC"],
  },
  {
    handle: "hadi",
    name: "Hadi Kusuma",
    login: "hadi.kusuma",
    orgRole: "engineer",
    title: "Frontend Engineer",
    projects: ["NPCP", "BSAC"],
  },
  {
    handle: "intan",
    name: "Intan Maharani",
    login: "intan.maharani",
    orgRole: "observer",
    title: "Product Owner",
    projects: [],
  },
  {
    handle: "joko",
    name: "Joko Santoso",
    login: "joko.santoso",
    orgRole: "infra",
    title: "Infrastructure Engineer",
    projects: [],
  },
];

// ISO weekdays as lib/user-display's zonedClock numbers them (Mon=1 … Fri=5).
export const STAFF_WORKING_HOURS: WorkingHours = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
};

export const STAFF_TIME_ZONE = "Asia/Jakarta";
