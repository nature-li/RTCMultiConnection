function MultiPeers(connection) {
    var self = this;

    // 除 streams 外，其它几个都是成员函数
    var skipPeers = ['getAllParticipants', 'getLength', 'selectFirst', 'streams', 'send', 'forEach'];

    // 所有已连接的 RTCPeerConnection
    connection.peers = {
        // 获取 this 中非 skipPeers 成员数量
        getLength: function() {
            var numberOfPeers = 0;
            for (var peer in this) {
                if (skipPeers.indexOf(peer) == -1) {
                    numberOfPeers++;
                }
            }
            return numberOfPeers;
        },
        // 获取第一个非 skipPeers 成员
        selectFirst: function() {
            var firstPeer;
            for (var peer in this) {
                if (skipPeers.indexOf(peer) == -1) {
                    firstPeer = this[peer];
                }
            }
            return firstPeer;
        },
        // 获取所有非 skipPeers 成员列表
        getAllParticipants: function(sender) {
            var allPeers = [];
            for (var peer in this) {
                if (skipPeers.indexOf(peer) == -1 && peer != sender) {
                    allPeers.push(peer);
                }
            }
            return allPeers;
        },
        // 针对所有非 skipPeers 调用成员函数
        forEach: function(callbcak) {
            this.getAllParticipants().forEach(function(participant) {
                callbcak(connection.peers[participant]);
            });
        },
        send: function(data, remoteUserId) {
            var that = this;

            if (!isNull(data.size) && !isNull(data.type)) {
                // 传输文件
                if (connection.enableFileSharing) {
                    self.shareFile(data, remoteUserId);
                    return;
                }

                // TODO: 没看懂
                if (typeof data !== 'string') {
                    data = JSON.stringify(data);
                }
            }

            if (data.type !== 'text' && !(data instanceof ArrayBuffer) && !(data instanceof DataView)) {
                TextSender.send({
                    text: data,
                    channel: this,
                    connection: connection,
                    remoteUserId: remoteUserId
                });
                return;
            }

            if (data.type === 'text') {
                data = JSON.stringify(data);
            }

            // 若指定 remoteUserId, 则定向发送数据
            if (remoteUserId) {
                var remoteUser = connection.peers[remoteUserId];
                if (remoteUser) {
                    if (!remoteUser.channels.length) {
                        connection.peers[remoteUserId].createDataChannel();
                        connection.renegotiate(remoteUserId);
                        setTimeout(function() {
                            that.send(data, remoteUserId);
                        }, 3000);
                        return;
                    }

                    // 向 remoteUser 的所有 channel 发送数据
                    remoteUser.channels.forEach(function(channel) {
                        channel.send(data);
                    });
                    return;
                }
            }

            // 向所有成员的所有 channel 发送数据
            this.getAllParticipants().forEach(function(participant) {
                if (!that[participant].channels.length) {
                    connection.peers[participant].createDataChannel();
                    connection.renegotiate(participant);
                    setTimeout(function() {
                        that[participant].channels.forEach(function(channel) {
                            channel.send(data);
                        });
                    }, 3000);
                    return;
                }

                that[participant].channels.forEach(function(channel) {
                    channel.send(data);
                });
            });
        }
    };

    this.uuid = connection.userid;

    /**
     * 返回值除 rtcMultiConnection 之外，均来自入口的3个参数
     */
    this.getLocalConfig = function(remoteSdp, remoteUserId, userPreferences) {
        if (!userPreferences) {
            userPreferences = {};
        }

        return {
            streamsToShare: userPreferences.streamsToShare || {},
            rtcMultiConnection: connection,
            connectionDescription: userPreferences.connectionDescription,
            userid: remoteUserId,
            localPeerSdpConstraints: userPreferences.localPeerSdpConstraints,
            remotePeerSdpConstraints: userPreferences.remotePeerSdpConstraints,
            dontGetRemoteStream: !!userPreferences.dontGetRemoteStream,
            dontAttachLocalStream: !!userPreferences.dontAttachLocalStream,
            renegotiatingPeer: !!userPreferences.renegotiatingPeer,
            peerRef: userPreferences.peerRef,
            channels: userPreferences.channels || [],
            onLocalSdp: function(localSdp) {
                self.onNegotiationNeeded(localSdp, remoteUserId);
            },
            onLocalCandidate: function(localCandidate) {
                localCandidate = OnIceCandidateHandler.processCandidates(connection, localCandidate)
                if (localCandidate) {
                    self.onNegotiationNeeded(localCandidate, remoteUserId);
                }
            },
            remoteSdp: remoteSdp,
            onDataChannelMessage: function(message) {
                if (!connection.fbr && connection.enableFileSharing) initFileBufferReader();

                if (typeof message == 'string' || !connection.enableFileSharing) {
                    self.onDataChannelMessage(message, remoteUserId);
                    return;
                }

                var that = this;

                if (message instanceof ArrayBuffer || message instanceof DataView) {
                    connection.fbr.convertToObject(message, function(object) {
                        that.onDataChannelMessage(object);
                    });
                    return;
                }

                if (message.readyForNextChunk) {
                    connection.fbr.getNextChunk(message, function(nextChunk, isLastChunk) {
                        connection.peers[remoteUserId].channels.forEach(function(channel) {
                            channel.send(nextChunk);
                        });
                    }, remoteUserId);
                    return;
                }

                if (message.chunkMissing) {
                    connection.fbr.chunkMissing(message);
                    return;
                }

                connection.fbr.addChunk(message, function(promptNextChunk) {
                    connection.peers[remoteUserId].peer.channel.send(promptNextChunk);
                });
            },
            onDataChannelError: function(error) {
                self.onDataChannelError(error, remoteUserId);
            },
            onDataChannelOpened: function(channel) {
                self.onDataChannelOpened(channel, remoteUserId);
            },
            onDataChannelClosed: function(event) {
                self.onDataChannelClosed(event, remoteUserId);
            },
            onRemoteStream: function(stream) {
                if (connection.peers[remoteUserId]) {
                    connection.peers[remoteUserId].streams.push(stream);
                }

                self.onGettingRemoteMedia(stream, remoteUserId);
            },
            onRemoteStreamRemoved: function(stream) {
                self.onRemovingRemoteMedia(stream, remoteUserId);
            },
            onPeerStateChanged: function(states) {
                // here -> MultiPeersHandler -> connection
                self.onPeerStateChanged(states);

                if (states.iceConnectionState === 'new') {
                    self.onNegotiationStarted(remoteUserId, states);
                }

                if (states.iceConnectionState === 'connected') {
                    self.onNegotiationCompleted(remoteUserId, states);
                }

                if (states.iceConnectionState.search(/closed|failed/gi) !== -1) {
                    self.onUserLeft(remoteUserId);
                    self.disconnectWith(remoteUserId);
                }
            }
        };
    };

    this.createNewPeer = function(remoteUserId, userPreferences) {
        // 人数过多，超过上限
        if (connection.maxParticipantsAllowed <= connection.getAllParticipants().length) {
            return;
        }

        userPreferences = userPreferences || {};

        if (connection.isInitiator && !!connection.session.audio && connection.session.audio === 'two-way' && !userPreferences.streamsToShare) {
            userPreferences.isOneWay = false;
            userPreferences.isDataOnly = false;
            userPreferences.session = connection.session;
        }

        // TODO： 没看懂这里，为什么就变成了 isOneWay = true 了
        if (!userPreferences.isOneWay && !userPreferences.isDataOnly) {
            userPreferences.isOneWay = true;
            this.onNegotiationNeeded({
                enableMedia: true,
                userPreferences: userPreferences
            }, remoteUserId);
            return;
        }

        userPreferences = connection.setUserPreferences(userPreferences, remoteUserId);
        var localConfig = this.getLocalConfig(null, remoteUserId, userPreferences);
        // 初始化 peers
        connection.peers[remoteUserId] = new PeerInitiator(localConfig);
    };

    this.createAnsweringPeer = function(remoteSdp, remoteUserId, userPreferences) {
        userPreferences = connection.setUserPreferences(userPreferences || {}, remoteUserId);

        var localConfig = this.getLocalConfig(remoteSdp, remoteUserId, userPreferences);
        connection.peers[remoteUserId] = new PeerInitiator(localConfig);
    };

    this.renegotiatePeer = function(remoteUserId, userPreferences, remoteSdp) {
        // 查找 peer
        if (!connection.peers[remoteUserId]) {
            if (connection.enableLogs) {
                console.error('Peer (' + remoteUserId + ') does not exist. Renegotiation skipped.');
            }
            return;
        }

        if (!userPreferences) {
            userPreferences = {};
        }

        userPreferences.renegotiatingPeer = true;
        userPreferences.peerRef = connection.peers[remoteUserId].peer;
        userPreferences.channels = connection.peers[remoteUserId].channels;

        var localConfig = this.getLocalConfig(remoteSdp, remoteUserId, userPreferences);

        connection.peers[remoteUserId] = new PeerInitiator(localConfig);
    };

    this.replaceTrack = function(track, remoteUserId, isVideoTrack) {
        if (!connection.peers[remoteUserId]) {
            throw 'This peer (' + remoteUserId + ') does not exist.';
        }

        var peer = connection.peers[remoteUserId].peer;

        if (!!peer.getSenders && typeof peer.getSenders === 'function' && peer.getSenders().length) {
            peer.getSenders().forEach(function(rtpSender) {
                if (isVideoTrack && rtpSender.track.kind === 'video') {
                    connection.peers[remoteUserId].peer.lastVideoTrack = rtpSender.track;
                    rtpSender.replaceTrack(track);
                }

                if (!isVideoTrack && rtpSender.track.kind === 'audio') {
                    connection.peers[remoteUserId].peer.lastAudioTrack = rtpSender.track;
                    rtpSender.replaceTrack(track);
                }
            });
            return;
        }

        console.warn('RTPSender.replaceTrack is NOT supported.');
        this.renegotiatePeer(remoteUserId);
    };

    this.onNegotiationNeeded = function(message, remoteUserId) {};
    this.addNegotiatedMessage = function(message, remoteUserId) {
        // 与 sdp 相关的操作
        if (message.type && message.sdp) {
            // 这里的 answer 和 offer 是 RTCSessionDescription 的只读属性
            if (message.type == 'answer') {
                if (connection.peers[remoteUserId]) {
                    // 调用 setRemoteDescription
                    connection.peers[remoteUserId].addRemoteSdp(message);
                }
            }

            // 这里的 answer 和 offer 是 RTCSessionDescription 的只读属性
            if (message.type == 'offer') {
                if (message.renegotiatingPeer) {
                    this.renegotiatePeer(remoteUserId, null, message);
                } else {
                    this.createAnsweringPeer(message, remoteUserId);
                }
            }

            if (connection.enableLogs) {
                console.log('Remote peer\'s sdp:', message.sdp);
            }
            return;
        }

        // 与 candidate 相关的操作
        if (message.candidate) {
            if (connection.peers[remoteUserId]) {
                connection.peers[remoteUserId].addRemoteCandidate(message);
            }

            if (connection.enableLogs) {
                console.log('Remote peer\'s candidate pairs:', message.candidate);
            }
            return;
        }

        // 触发重新协商 stream 操作
        if (message.enableMedia) {
            connection.session = message.userPreferences.session || connection.session;

            if (connection.session.oneway && connection.attachStreams.length) {
                connection.attachStreams = [];
            }

            if (message.userPreferences.isDataOnly && connection.attachStreams.length) {
                // 这里是不是一个 bug ?
                connection.attachStreams.length = [];
            }

            var streamsToShare = {};
            connection.attachStreams.forEach(function(stream) {
                streamsToShare[stream.streamid] = {
                    isAudio: !!stream.isAudio,
                    isVideo: !!stream.isVideo,
                    isScreen: !!stream.isScreen
                };
            });
            message.userPreferences.streamsToShare = streamsToShare;

            self.onNegotiationNeeded({
                readyForOffer: true,
                userPreferences: message.userPreferences
            }, remoteUserId);
        }

        // 对端准备好接收视频数据了
        if (message.readyForOffer) {
            connection.onReadyForOffer(remoteUserId, message.userPreferences);
        }

        function cb(stream) {
            gumCallback(stream, message, remoteUserId);
        }
    };

    function gumCallback(stream, message, remoteUserId) {
        // 获取 streamsToShare
        var streamsToShare = {};
        connection.attachStreams.forEach(function(stream) {
            streamsToShare[stream.streamid] = {
                isAudio: !!stream.isAudio,
                isVideo: !!stream.isVideo,
                isScreen: !!stream.isScreen
            };
        });
        message.userPreferences.streamsToShare = streamsToShare;

        // 调用 onNegotiationNeeded(本函数在 connection 初始化时被重写了)
        self.onNegotiationNeeded({
            readyForOffer: true,
            userPreferences: message.userPreferences
        }, remoteUserId);
    }

    this.onGettingRemoteMedia = function(stream, remoteUserId) {};
    this.onRemovingRemoteMedia = function(stream, remoteUserId) {};
    // 这个函数在 RTCMultiConnection 中被重写了
    this.onGettingLocalMedia = function(localStream) {};
    this.onLocalMediaError = function(error, constraints) {
        // 触发回调函数
        connection.onMediaError(error, constraints);
    };

    function initFileBufferReader() {
        connection.fbr = new FileBufferReader();
        connection.fbr.onProgress = function(chunk) {
            connection.onFileProgress(chunk);
        };
        connection.fbr.onBegin = function(file) {
            connection.onFileStart(file);
        };
        connection.fbr.onEnd = function(file) {
            connection.onFileEnd(file);
        };
    }

    // TODO: 2019-03-25 太复杂，先略过
    this.shareFile = function(file, remoteUserId) {
        initFileBufferReader();

        connection.fbr.readAsArrayBuffer(file, function(uuid) {
            var arrayOfUsers = connection.getAllParticipants();

            if (remoteUserId) {
                arrayOfUsers = [remoteUserId];
            }

            arrayOfUsers.forEach(function(participant) {
                connection.fbr.getNextChunk(uuid, function(nextChunk) {
                    connection.peers[participant].channels.forEach(function(channel) {
                        channel.send(nextChunk);
                    });
                }, participant);
            });
        }, {
            userid: connection.userid,
            // extra: connection.extra,
            chunkSize: DetectRTC.browser.name === 'Firefox' ? 15 * 1000 : connection.chunkSize || 0
        });
    };

    if (typeof 'TextReceiver' !== 'undefined') {
        var textReceiver = new TextReceiver(connection);
    }

    this.onDataChannelMessage = function(message, remoteUserId) {
        // 最终触发 connection 的 onmessage 函数
        textReceiver.receive(JSON.parse(message), remoteUserId, connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {});
    };

    this.onDataChannelClosed = function(event, remoteUserId) {
        event.userid = remoteUserId;
        event.extra = connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {};
        // 调用回调函数
        connection.onclose(event);
    };

    this.onDataChannelError = function(error, remoteUserId) {
        error.userid = remoteUserId;
        event.extra = connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {};
        // 调用回调函数
        connection.onerror(error);
    };

    this.onDataChannelOpened = function(channel, remoteUserId) {
        // channels 列表中只保存一个成员
        // keep last channel only; we are not expecting parallel/channels channels
        if (connection.peers[remoteUserId].channels.length) {
            connection.peers[remoteUserId].channels = [channel];
            return;
        }

        // 保存 channel
        connection.peers[remoteUserId].channels.push(channel);
        // 调用回调函数
        connection.onopen({
            userid: remoteUserId,
            extra: connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra : {},
            channel: channel
        });
    };

    // 调用 connection 的 onPeerStateChanged 函数
    this.onPeerStateChanged = function(state) {
        connection.onPeerStateChanged(state);
    };

    this.onNegotiationStarted = function(remoteUserId, states) {};
    this.onNegotiationCompleted = function(remoteUserId, states) {};

    // 获取远程 streams
    this.getRemoteStreams = function(remoteUserId) {
        remoteUserId = remoteUserId || connection.peers.getAllParticipants()[0];
        return connection.peers[remoteUserId] ? connection.peers[remoteUserId].streams : [];
    };
}
