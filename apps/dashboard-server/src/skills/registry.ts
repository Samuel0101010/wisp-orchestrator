import { loadAllSkills } from './loader.js';
import { discoverSkills, type DiscoveryOpts } from './discovery.js';
import type { Skill } from './types.js';

/**
 * Three init modes:
 *   - `new SkillRegistry(rootDir)`              — loads from a single dir on init() (back-compat for tests)
 *   - `new SkillRegistry({ skills: [...] })`    — uses the explicit list; init() is a no-op refresh
 *   - `new SkillRegistry({ discoveryOpts })`    — runs full multi-source discovery on init()
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private readonly rootDir?: string;
  private readonly explicit?: Skill[];
  private readonly discoveryOpts?: DiscoveryOpts;

  constructor(arg: string | { skills: Skill[] } | { discoveryOpts: DiscoveryOpts }) {
    if (typeof arg === 'string') {
      this.rootDir = arg;
    } else if ('skills' in arg) {
      this.explicit = arg.skills;
    } else {
      this.discoveryOpts = arg.discoveryOpts;
    }
  }

  init(): void {
    this.skills.clear();
    const loaded = this.explicit
      ? this.explicit
      : this.discoveryOpts
        ? discoverSkills(this.discoveryOpts).skills
        : this.rootDir
          ? loadAllSkills(this.rootDir)
          : [];
    for (const s of loaded) this.skills.set(s.name, s);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }
  reload(): void {
    this.init();
  }
}
