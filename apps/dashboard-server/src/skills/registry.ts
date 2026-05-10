import { loadAllSkills } from './loader.js';
import type { Skill } from './types.js';

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  constructor(private rootDir: string) {}

  init(): void {
    this.skills.clear();
    for (const s of loadAllSkills(this.rootDir)) this.skills.set(s.name, s);
  }

  list(): Skill[] { return [...this.skills.values()]; }
  get(name: string): Skill | undefined { return this.skills.get(name); }
  reload(): void { this.init(); }
}
