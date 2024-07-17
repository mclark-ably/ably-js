'use strict';

define(['ably', 'shared_helper', 'async', 'chai'], function (Ably, helper, async, chai) {
  var expect = chai.expect;
  var closeAndFinish = helper.closeAndFinish;
  var utils = helper.Utils;
  var noop = function () {};
  var simulateDroppedConnection = helper.simulateDroppedConnection;
  var createPM = Ably.protocolMessageFromDeserialized;
  var availableTransports = helper.availableTransports;
  var testOnAllTransports = helper.testOnAllTransports;
  var whenPromiseSettles = helper.whenPromiseSettles;

  describe('realtime/failure', function () {
    this.timeout(60 * 1000);
    before(function (done) {
      helper.setupApp(function (err) {
        if (err) {
          done(err);
          return;
        }
        done();
      });
    });

    /**
     * Connect with invalid credentials on various transports; connection state should be 'failed'
     *
     * @spec RTN14a
     */
    it('invalid_cred_failure', function (done) {
      try {
        var failure_test = function (transports) {
          return function (cb) {
            var realtime = helper.AblyRealtime({ key: 'this.is:wrong', transports: transports });
            realtime.connection.on('failed', function (connectionStateChange) {
              try {
                expect(realtime.connection.errorReason.code).to.equal(40400, 'wrong error reason code on connection.');
                expect(connectionStateChange.reason.code).to.equal(
                  40400,
                  'wrong error reason code on connectionStateChange',
                );
                expect(connectionStateChange.reason).to.deep.equal(
                  realtime.connection.errorReason,
                  'error reason was not equally set on connection and connectionStateChange',
                );
              } catch (err) {
                cb(err, realtime);
                return;
              }
              cb(null, realtime);
            });
            realtime.connection.on('disconnected', function () {
              cb(
                new Error('connection state for transports ' + transports + ' should be failed, not disconnected'),
                realtime,
              );
            });
          };
        };
        async.parallel(
          availableTransports
            .map(function (transport) {
              return failure_test([transport]);
            })
            .concat(failure_test(null)), // to test not specifying a transport (so will use websocket/base mechanism)
          function (err, realtimes) {
            closeAndFinish(done, realtimes, err);
          },
        );
      } catch (err) {
        done(err);
      }
    });

    /**
     * Connect with various transports, forcibly break the transport, connection state
     * should be 'disconnected'
     *
     * @specpartial RTN14d - test only transition to DISCONNECTED
     */
    it('break_transport', function (done) {
      try {
        var break_test = function (transports) {
          return function (cb) {
            var realtime = helper.AblyRealtime({ transports: transports });
            realtime.connection.once('connected', function () {
              realtime.connection.once('disconnected', function () {
                cb(null, realtime);
              });
              realtime.connection.on('failed', function () {
                cb(
                  new Error('connection state for transports ' + transports + ' should be disconnected, not failed'),
                  realtime,
                );
              });
              simulateDroppedConnection(realtime);
            });
          };
        };
        async.parallel(
          availableTransports
            .map(function (transport) {
              return break_test([transport]);
            })
            .concat(break_test(null)), // to test not specifying a transport (so will use websocket/base mechanism)
          function (err, realtimes) {
            closeAndFinish(done, realtimes, err);
          },
        );
      } catch (err) {
        closeAndFinish(done, realtime, err);
      }
    });

    /**
     * Connect with various transports with a bad host, check that
     * the connecting/disconnecting/suspended cycle works as expected.
     * Related to RTB1, DF1a, TO3l1, TO3l11, TO3l2.
     *
     * @spec RTN14e
     * @spec RTN14f
     * @specpartial RTN14d - doesn't test fallback hosts used
     */
    it('no_connection_lifecycle', function (done) {
      try {
        var lifecycleTest = function (transports) {
          return function (cb) {
            var connectionEvents = [];
            var realtime = helper.AblyRealtime({
              transports: transports,
              realtimeHost: 'invalid',
              restHost: 'invalid',
              /* Timings note: some transports fail immediately with an invalid
               * host, others take longer; so set the realtimeRequestTimeout to be
               * small enough that the max difference is never large enough that
               * the suspended timeout trips before three connection cycles */
              disconnectedRetryTimeout: 1000,
              realtimeRequestTimeout: 50,
              webSocketConnectTimeout: 50,
              suspendedRetryTimeout: 1000,
              connectionStateTtl: 2900,
            });
            realtime.connection.on(function () {
              connectionEvents.push(this.event);
            });

            /* After 4s, has been through three connecting/disconnected cycles
             * and one connecting/suspended cycles */
            var expectedConnectionEvents = [
              'connecting',
              'disconnected', // immediately
              'connecting',
              'disconnected', // at 1s
              'connecting',
              'disconnected', // at 2s
              'suspended', // at 2.9s
              'connecting',
              'suspended', // at 3.9s
            ];
            setTimeout(function () {
              try {
                expect(connectionEvents).to.deep.equal(
                  expectedConnectionEvents,
                  'connection state for ' +
                    transports +
                    ' was ' +
                    connectionEvents +
                    ', expected ' +
                    expectedConnectionEvents,
                );
                realtime.close();
                cb(null, realtime);
              } catch (err) {
                realtime.close();
                cb(err);
              }
            }, 4800);
          };
        };
        async.parallel(
          availableTransports
            .map(function (transport) {
              return lifecycleTest([transport]);
            })
            .concat(lifecycleTest(null)), // to test not specifying a transport (so will use websocket/base mechanism)
          function (err) {
            if (err) {
              done(err);
            }
            done();
          },
        );
      } catch (err) {
        closeAndFinish(done, realtime, err);
      }
    });

    function checkIsBetween(value, min, max) {
      expect(value).to.be.above(min);
      expect(value).to.be.below(max);
    }

    availableTransports.forEach(function (transport) {
      /**
       * @spec RTB1a
       * @spec RTB1b
       * @spec TO3l1
       * @specpartial RTB1 - test backoff for connection
       * @specpartial RTN14d - retries and retryIn calculation
       * @specpartial TA2 - retryIn passed in ConnectionStateChange
       */
      it('disconnected_backoff_' + transport, function (done) {
        var disconnectedRetryTimeout = 150;
        var realtime = helper.AblyRealtime({
          disconnectedRetryTimeout: disconnectedRetryTimeout,
          realtimeHost: 'invalid',
          restHost: 'invalid',
          transports: [transport],
        });

        var retryCount = 0;
        var retryTimeouts = [];

        realtime.connection.on(function (stateChange) {
          if (stateChange.previous === 'connecting' && stateChange.current === 'disconnected') {
            if (retryCount > 4) {
              // Upper bound = min((retryAttempt + 2) / 3, 2) * initialTimeout
              // Lower bound = 0.8 * Upper bound
              checkIsBetween(retryTimeouts[0], 120, 150);
              checkIsBetween(retryTimeouts[1], 160, 200);
              checkIsBetween(retryTimeouts[2], 200, 250);

              for (var i = 3; i < retryTimeouts.length; i++) {
                checkIsBetween(retryTimeouts[i], 240, 300);
              }
              closeAndFinish(done, realtime);
              return;
            }
            try {
              retryTimeouts.push(stateChange.retryIn);
              retryCount += 1;
            } catch (err) {
              closeAndFinish(done, realtime, err);
            }
          }
        });
      });
    });

    /**
     * Check operations on a failed channel give the right errors
     * Related to RTL11, RTL7, RTL4d.
     *
     * @specpartial RTL6b - error when called in FAILED state
     * @specpartial RTP14b - error on enter presence
     * @specpartial RTP15d - error on leave presence
     */
    it('failed_channel', function (done) {
      var realtime = helper.AblyRealtime();
      var failChan;
      var channelFailedCode = 90001;

      var tests = [
        function (callback) {
          whenPromiseSettles(failChan.publish('event', 'data'), function (err) {
            try {
              expect(err, 'publish failed').to.be.ok;
              expect(err.code).to.equal(channelFailedCode, 'publish failure code');
              callback();
            } catch (err) {
              callback(err);
            }
          });
        },
        function (callback) {
          whenPromiseSettles(failChan.subscribe('event', noop), function (err) {
            try {
              expect(err, 'subscribe failed').to.be.ok;
              expect(err.code).to.equal(channelFailedCode, 'subscribe failure code');
              callback();
            } catch (err) {
              callback(err);
            }
          });
        },
        function (callback) {
          whenPromiseSettles(failChan.presence.enterClient('clientId'), function (err) {
            try {
              expect(err, 'presence enter failed').to.be.ok;
              expect(err.code).to.equal(channelFailedCode, 'presence enter failure code');
              callback();
            } catch (err) {
              callback(err);
            }
          });
        },
        function (callback) {
          whenPromiseSettles(failChan.presence.leaveClient('clientId'), function (err) {
            try {
              expect(err, 'presence leave failed').to.be.ok;
              expect(err.code).to.equal(channelFailedCode, 'presence leave failure code');
              callback();
            } catch (err) {
              callback(err);
            }
          });
        },
        function (callback) {
          whenPromiseSettles(failChan.presence.subscribe('event', noop), function (err) {
            try {
              expect(err, 'presence subscribe failed').to.be.ok;
              expect(err.code).to.equal(channelFailedCode, 'subscribe failure code');
              callback();
            } catch (err) {
              callback(err);
            }
          });
        },
        function (callback) {
          whenPromiseSettles(failChan.presence.subscribe('event', noop), function (err) {
            try {
              expect(err, 'presence unsubscribe failed').to.be.ok;
              expect(err.code).to.equal(channelFailedCode, 'subscribe failure code');
              callback();
            } catch (err) {
              callback(err);
            }
          });
        },
        function (callback) {
          whenPromiseSettles(failChan.presence.get(), function (err) {
            try {
              expect(err, 'presence get failed').to.be.ok;
              expect(err.code).to.equal(channelFailedCode, 'presence get failure code');
              callback();
            } catch (err) {
              callback(err);
            }
          });
        },
      ];

      try {
        realtime.connection.once('connected', function () {
          failChan = realtime.channels.get('::');
          whenPromiseSettles(failChan.attach(), function (err) {
            try {
              expect(err, 'channel attach failed').to.be.ok;
              expect(failChan.state).to.equal('failed', 'channel in failed state');
            } catch (err) {
              closeAndFinish(done, realtime, err);
              return;
            }
            async.parallel(tests, function (err) {
              closeAndFinish(done, realtime, err);
            });
          });
        });
      } catch (err) {
        closeAndFinish(done, realtime, err);
      }
    });

    /**
     * @spec RTL4f
     * @specpartial RTL13b - tests re-attach attempt once
     */
    it('attach_timeout', function (done) {
      var realtime = helper.AblyRealtime({ realtimeRequestTimeout: 2000, channelRetryTimeout: 1000 }),
        channel = realtime.channels.get('failed_attach'),
        originalProcessMessage = channel.processMessage.bind(channel);

      channel.processMessage = async function (message) {
        if (message.action === 11) {
          return;
        }
        await originalProcessMessage(message);
      };

      realtime.connection.once('connected', function () {
        whenPromiseSettles(channel.attach(), function (err) {
          try {
            expect(err.code).to.equal(90007, 'check channel error code');
            expect(err.statusCode).to.equal(408, 'check timeout statusCode');
            expect(channel.state).to.equal('suspended', 'check channel goes into suspended state');
          } catch (err) {
            closeAndFinish(done, realtime, err);
            return;
          }
          channel.once(function (stateChange) {
            try {
              expect(stateChange.current).to.equal('attaching', 'check channel tries to attach again');
              closeAndFinish(done, realtime);
            } catch (err) {
              closeAndFinish(done, realtime, err);
            }
          });
        });
      });
    });

    availableTransports.forEach(function (transport) {
      /**
       * @spec RTL13b
       * @spec RTB1a
       * @spec RTB1b
       * @spec TO3l7
       * @specpartial RTB1 - test backoff for channel
       */
      it('channel_backoff_' + transport, function (done) {
        var channelRetryTimeout = 150;
        var realtime = helper.AblyRealtime({
            channelRetryTimeout: channelRetryTimeout,
            transports: [transport],
          }),
          channel = realtime.channels.get('failed_attach'),
          originalProcessMessage = channel.processMessage.bind(channel),
          retryCount = 0;

        var performance = isBrowser ? window.performance : require('perf_hooks').performance;

        channel.processMessage = async function (message) {
          // Ignore ATTACHED messages
          if (message.action === 11) {
            return;
          }
          await originalProcessMessage(message);
        };

        var retryTimeouts = [];

        realtime.connection.on('connected', function () {
          realtime.options.timeouts.realtimeRequestTimeout = 1;
          whenPromiseSettles(channel.attach(), function (err) {
            if (err) {
              var lastSuspended = performance.now();
              channel.on(function (stateChange) {
                if (stateChange.current === 'suspended') {
                  if (retryCount > 4) {
                    // Upper bound = min((retryAttempt + 2) / 3, 2) * initialTimeout
                    // Lower bound = 0.8 * Upper bound
                    // Additional 10 is a calculationDelayTimeout
                    checkIsBetween(retryTimeouts[0], 120, 150 + 10);
                    checkIsBetween(retryTimeouts[1], 160, 200 + 10);
                    checkIsBetween(retryTimeouts[2], 200, 250 + 10);

                    for (var i = 3; i < retryTimeouts.length; i++) {
                      checkIsBetween(retryTimeouts[i], 240, 300 + 10);
                    }
                    closeAndFinish(done, realtime);
                    return;
                  }
                  var elapsedSinceSuspneded = performance.now() - lastSuspended;
                  lastSuspended = performance.now();
                  try {
                    retryTimeouts.push(elapsedSinceSuspneded);
                    retryCount += 1;
                  } catch (err) {
                    closeAndFinish(done, realtime, err);
                  }
                }
              });
            } else {
              closeAndFinish(done, realtime, new Error('Expected channel attach to timeout'));
            }
          });
        });
      });
    });

    /* RTN7c
     * Publish a message, then before it receives an ack, disconnect the
     * transport, and let the connection go into some terminal failure state.
     * Check that the publish callback is called with an error.
     */
    function nack_on_connection_failure(failureFn, expectedRealtimeState, expectedNackCode) {
      return function (done) {
        /* Use one transport because stubbing out transport#onProtocolMesage */
        var realtime = helper.AblyRealtime({ transports: [helper.bestTransport] }),
          channel = realtime.channels.get('nack_on_connection_failure');

        async.series(
          [
            function (cb) {
              realtime.connection.once('connected', function () {
                cb();
              });
            },
            function (cb) {
              whenPromiseSettles(channel.attach(), cb);
            },
            function (cb) {
              var transport = realtime.connection.connectionManager.activeProtocol.transport,
                originalOnProtocolMessage = transport.onProtocolMessage;

              transport.onProtocolMessage = function (message) {
                /* make sure we don't get an ack! */
                if (message.action !== 1) {
                  originalOnProtocolMessage.apply(this, arguments);
                }
              };
              whenPromiseSettles(channel.publish('foo', 'bar'), function (err) {
                try {
                  expect(err, 'Publish failed as expected').to.be.ok;
                  expect(realtime.connection.state).to.equal(
                    expectedRealtimeState,
                    'check realtime state is ' + expectedRealtimeState,
                  );
                  expect(err.code).to.equal(expectedNackCode, 'Check error code was ' + expectedNackCode);
                  cb();
                } catch (err) {
                  cb(err);
                }
              });
              Ably.Realtime.Platform.Config.nextTick(function () {
                failureFn(realtime);
              });
            },
          ],
          function (err) {
            closeAndFinish(done, realtime, err);
          },
        );
      };
    }

    /** @specpartial RTN7c - test for SUSPENDED */
    it(
      'nack_on_connection_suspended',
      nack_on_connection_failure(
        function (realtime) {
          helper.becomeSuspended(realtime);
        },
        'suspended',
        80002,
      ),
    );

    /** @specpartial RTN7c - test for FAILED */
    it(
      'nack_on_connection_failed',
      nack_on_connection_failure(
        function (realtime) {
          realtime.connection.connectionManager.activeProtocol.transport.onProtocolMessage({
            action: 9,
            error: { statusCode: 401, code: 40100, message: 'connection failed because reasons' },
          });
        },
        'failed',
        40100,
      ),
    );

    /** @specpartial RTN7c - test for CLOSED */
    it(
      'nack_on_connection_closed',
      nack_on_connection_failure(
        function (realtime) {
          realtime.close();
        },
        'closed',
        80017,
      ),
    );

    /** @spec RTN23a */
    it('idle_transport_timeout', function (done) {
      var realtime = helper.AblyRealtime({ realtimeRequestTimeout: 2000 }),
        originalOnProtocolMessage;

      realtime.connection.connectionManager.on('transport.pending', function (transport) {
        originalOnProtocolMessage = transport.onProtocolMessage;
        transport.onProtocolMessage = function (message) {
          if (message.action === 4) {
            message.connectionDetails.maxIdleInterval = 100;
          }
          originalOnProtocolMessage.call(this, message);
        };
      });

      realtime.connection.once('connected', function () {
        realtime.connection.once(function (statechange) {
          /* will go to connecting if there's another transport scheduled for activation */
          try {
            expect(
              statechange.current === 'disconnected' || statechange.current === 'connecting',
              'check connection goes to disconnected/connecting',
            ).to.be.ok;
            expect(statechange.reason.code).to.equal(80003, 'check code');
            expect(statechange.reason.statusCode).to.equal(408, 'check statusCode');
          } catch (err) {
            closeAndFinish(done, realtime, err);
            return;
          }
          closeAndFinish(done, realtime);
        });
      });
    });

    /** @specpartial RTN14d - last sentence: check that if we received a 5xx disconnected, when we try again we use a fallback host */
    testOnAllTransports('try_fallback_hosts_on_placement_constraint', function (realtimeOpts) {
      return function (done) {
        /* Use the echoserver as a fallback host because it doesn't support
         * websockets, so it'll fail to connect, which we can detect */
        var realtime = helper.AblyRealtime(utils.mixin({ fallbackHosts: ['echo.ably.io'] }, realtimeOpts)),
          connection = realtime.connection,
          connectionManager = connection.connectionManager;

        connection.once('connected', function () {
          connection.once('connecting', function () {
            connection.once(function (stateChange) {
              try {
                expect(stateChange.current).to.equal(
                  'disconnected',
                  'expect next connection attempt to fail due to using the (bad) fallback host',
                );
              } catch (err) {
                closeAndFinish(done, realtime, err);
                return;
              }
              closeAndFinish(done, realtime);
            });
          });
          connectionManager.activeProtocol.getTransport().onProtocolMessage(
            createPM({
              action: 6,
              error: {
                message: 'fake placement constraint',
                code: 50320,
                statusCode: 503,
              },
            }),
          );
        });
      };
    });

    /** @spec RTL17 */
    it('no_messages_if_not_attached', function (done) {
      var testName = 'no_messages_if_not_attached';
      var testMessage = { foo: 'bar', count: 1, status: 'active' };
      var testMessage2 = { foo: 'bar', count: 2, status: 'active' };

      try {
        var sender_realtime = helper.AblyRealtime();
        var sender_channel = sender_realtime.channels.get(testName);
        var messageReceived = false;

        sender_channel.subscribe(function (message) {
          if (messageReceived) {
            closeAndFinish(done, realtime, new Error('Message received when channel not in ATTACHED state.'));
          }

          try {
            messageReceived = true;
            expect(testMessage).to.deep.equal(message.data, 'Check first message received');

            var connectionManager = sender_realtime.connection.connectionManager;
            var onChannelMsgOrig = connectionManager.onChannelMessage;
            connectionManager.onChannelMessage = function (msg, transport) {
              if (msg.action === 15) {
                sender_channel.requestState('attaching');
              }
              onChannelMsgOrig.call(connectionManager, msg, transport);
            };

            sender_channel.publish('1', testMessage2);

            setTimeout(function () {
              closeAndFinish(done, sender_realtime);
            }, 7000);
          } catch (err) {
            closeAndFinish(done, sender_realtime, err);
          }
        });

        sender_realtime.connection.on('connected', function () {
          sender_channel.publish('0', testMessage);
        });
      } catch (err) {
        closeAndFinish(done, sender_realtime, err);
      }
    });
  });
});
