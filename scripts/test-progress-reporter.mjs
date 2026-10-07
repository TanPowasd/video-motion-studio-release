import { writeFileSync } from 'node:fs';
export default class TestProgressReporter {
  active = new Map();
  publish() {
    if (process.env.VMOTION_TEST_ACTIVITY)
      writeFileSync(
        process.env.VMOTION_TEST_ACTIVITY,
        JSON.stringify({ at: new Date().toISOString(), active: [...this.active.values()] }),
      );
  }
  onTestCaseReady(test) {
    this.active.set(test.id, { file: test.module.moduleId, name: test.fullName });
    this.publish();
  }
  onTestCaseResult(test) {
    this.active.delete(test.id);
    this.publish();
  }
}
