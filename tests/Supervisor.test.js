import assert from 'assert';
import Supervisor from '../src/internal/Supervisor';
import { fork } from './support';

describe('PoolHall Supervisor', () => {
  describe('configure', () => {
    let supervisor;

    beforeEach(() => {
      supervisor = new Supervisor(fork);
    });

    it('throws an error on missing settings', () => {
      assert.throws(() => {
        supervisor.configure({}, {});
      });
      assert.throws(() => {
        supervisor.configure({ workerCount: 1 }, {});
      });
      assert.throws(() => {
        supervisor.configure({ workerEnv: () => ({}) });
      });
    });

    it('does not throw an error when all required settings are provided', () => {
      assert.doesNotThrow(() => {
        supervisor.configure({ workerCount: 1, workerEnv: () => ({}) });
      });
    });

    it('throws an error if already configured', () => {
      supervisor.configure({ workerCount: 1, workerEnv: () => ({}) });
      assert.throws(() => {
        supervisor.configure({ workerCount: 1, workerEnv: () => ({}) });
      });
    });

    it('uses a provided minWorkerCount', () => {
      supervisor.configure({ workerCount: 6, workerEnv: () => ({}), minWorkerCount: 2 });
      assert.equal(supervisor.settings.minWorkerCount, 2);
    });

    it('uses a provided minWorkerCount of zero', () => {
      supervisor.configure({ workerCount: 6, workerEnv: () => ({}), minWorkerCount: 0 });
      assert.equal(supervisor.settings.minWorkerCount, 0);
    });

    it('uses a default minWorkerCount with many workers', () => {
      supervisor.configure({ workerCount: 15, workerEnv: () => ({}) });
      assert.equal(supervisor.settings.minWorkerCount, 13);
    });

    it('uses a default minWorkerCount with few workers', () => {
      supervisor.configure({ workerCount: 2, workerEnv: () => ({}) });
      assert.equal(supervisor.settings.minWorkerCount, 2);
    });
  });

  describe('start', () => {
    let supervisor;

    beforeEach(() => {
      supervisor = new Supervisor(fork);
      supervisor.configure({ workerCount: 2, workerEnv: id => ({ POOL_PORT: `${9000 + (+id)}` }) }, {
        execArgv: [], env: {}, exec: 'foo.js', args: [],
      });
    });

    it('creates a worker pool', () => {
      assert.equal(Object.keys(supervisor.workers).length, 0);
      supervisor.start();
      assert.equal(Object.keys(supervisor.workers).length, 2);
      assert.equal(supervisor.workers['1'].process.forkArgs.options.env.POOL_PORT, '9001');
      assert.equal(supervisor.workers['2'].process.forkArgs.options.env.POOL_PORT, '9002');
    });

    describe('worker events', () => {
      it('forwards individual worker events to the pool', (done) => {
        supervisor.start();

        supervisor.on('workerUp', (id) => {
          assert.equal(id, '1');

          supervisor.on('workerDown', (id2) => {
            assert.equal(id2, '2');
            done();
          });

          supervisor.workers['2'].emit('down');
        });

        supervisor.workers['1'].emit('up');
      });

      it('watches the process exit event', (done) => {
        supervisor.start();

        supervisor.on('workerDown', (id, info) => {
          assert.equal(id, '1');
          assert.equal(info.exitCode, 1);
          done();
        });

        supervisor.workers['1'].process.emit('exit', 1, null);
      });

      it('watches the process clean exit event', (done) => {
        supervisor.start();

        supervisor.on('workerTerminated', (id) => {
          assert.equal(id, '1');
          done();
        });

        supervisor.workers['1'].process.emit('exit', 0, null);
      });

      it('handles internal pool messages', (done) => {
        supervisor.start();

        supervisor.on('workerUp', (id) => {
          assert.equal(id, '1');

          done();
        });

        supervisor.workers['1'].process.emit('message', { poolHallInternal: true, act: 'ready' });
      });
    });

    describe('worker replacement', () => {
      it('replaces workers that exit with error', (done) => {
        supervisor.start();

        const worker = supervisor.workers['1'];
        const oldProcessId = worker.process.processId;

        worker.once('down', () => {
          setTimeout(() => {
            assert.notEqual(worker.process.processId, oldProcessId);
            done();
          }, 0);
        });

        worker.process.emit('exit', 1, null);
      });

      it('does not replace workers that exit without error', (done) => {
        supervisor.start();

        const worker = supervisor.workers['1'];
        const oldProcessId = worker.process.processId;

        worker.once('down', () => {
          setTimeout(() => {
            assert.equal(worker.process.processId, oldProcessId);
            done();
          }, 0);
        });

        worker.process.emit('exit', 0, null);
      });
      it('replaces replacement workers that exit with error', (done) => {
        supervisor.start();

        const worker = supervisor.workers['1'];
        const oldProcessId = worker.process.processId;

        worker.once('down', () => {
          setTimeout(() => {
            const replacementProcessId = worker.process.processId;
            assert.notEqual(replacementProcessId, oldProcessId);

            worker.once('down', () => {
              setTimeout(() => {
                assert.notEqual(worker.process.processId, replacementProcessId);
                done();
              }, 0);
            });

            worker.process.emit('exit', 1, null);
          }, 0);
        });

        worker.process.emit('exit', 1, null);
      });
    });

    describe('pool health', () => {
      function returningPromise(action, promise) {
        const p = new Promise(resolve => promise(resolve));
        action();
        return p;
      }

      it('changes health status based on whether processes are up', () => {
        supervisor = new Supervisor(fork);
        supervisor.configure({ workerCount: 6, workerEnv: () => ({}) }, {
          execArgv: [], env: {}, exec: 'foo.js', args: [],
        });
        supervisor.start();

        const workers = Object.values(supervisor.workers);

        return Promise.all(workers.map(worker => returningPromise(
          () => worker.process.emit('message', { poolHallInternal: true, act: 'ready' }),
          resolve => worker.once('up', resolve),
        ))).then(() => {
          workers.forEach((worker) => {
            const lastMessage = worker.process.sentMessages.pop()[0];
            const penultimateMessage = worker.process.sentMessages.pop()[0];

            assert.equal(lastMessage.act, 'healthy');
            assert.equal(penultimateMessage.act, 'unhealthy');
          });

          return Promise.all(['1', '2', '6'].map(id => returningPromise(
            () => supervisor.workers[id].process.emit('exit', 1, null),
            resolve => supervisor.workers[id].once('down', resolve),
          )));
        }).then(() => {
          workers.forEach((worker) => {
            const lastMessage = worker.process.sentMessages.pop()[0];
            const penultimateMessage = worker.process.sentMessages.pop()[0];

            assert.equal(lastMessage.act, 'unhealthy');
            assert.equal(penultimateMessage.act, 'healthy');
          });

          return returningPromise(
            () => supervisor.workers['1'].process.emit('message', { poolHallInternal: true, act: 'ready' }),
            resolve => supervisor.workers['1'].once('up', resolve),
          );
        }).then(() => {
          workers.forEach((worker) => {
            const lastMessage = worker.process.sentMessages.pop()[0];
            assert.equal(lastMessage.act, 'healthy');
          });
        });
      });
    });
  });
});
