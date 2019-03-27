function SocketConnection(connection, connectCallback) {
    // 纯 data
    function isData(session) {
        return !session.audio && !session.video && !session.screen && session.data;
    }

    // socket 连接参数
    var parameters = '';

    // 用户id
    parameters += '?userid=' + connection.userid;
    // sessionId === roomId
    parameters += '&sessionid=' + connection.sessionid;
    //TODO: 始终没看明白作者的意图
    parameters += '&msgEvent=' + connection.socketMessageEvent;
    // 所有连接都会被 broadcast 到这种消息
    parameters += '&socketCustomEvent=' + connection.socketCustomEvent;
    // 房主退出时是否关掉整个房间
    parameters += '&autoCloseEntireSession=' + !!connection.autoCloseEntireSession;

    // 此参数 client 和 server 都没有用到
    if (connection.session.broadcast === true) {
        parameters += '&oneToMany=true';
    }

    // 房间内最大成员数限制
    parameters += '&maxParticipantsAllowed=' + connection.maxParticipantsAllowed;

    // 非主播收到信息后是否可以代播
    if (connection.enableScalableBroadcast) {
        parameters += '&enableScalableBroadcast=true';
        parameters += '&maxRelayLimitPerUser=' + (connection.maxRelayLimitPerUser || 2);
    }

    // 附加数据
    parameters += '&extra=' + JSON.stringify(connection.extra || {});

    // 附加参数，如: &fullName=Muaz&country=PK&meetingId=xyz
    if (connection.socketCustomParameters) {
        parameters += connection.socketCustomParameters;
    }

    // TODO: 没看明白
    try {
        io.sockets = {};
    } catch (e) {};

    // RTCMultiConnection-Server 地址
    if (!connection.socketURL) {
        connection.socketURL = '/';
    }

    // 确保 socketURL 以 / 结尾
    if (connection.socketURL.substr(connection.socketURL.length - 1, 1) != '/') {
        // connection.socketURL = 'https://domain.com:9001/';
        throw '"socketURL" MUST end with a slash.';
    }

    // 打印 socketURL 完整地址
    if (connection.enableLogs) {
        if (connection.socketURL == '/') {
            console.info('socket.io url is: ', location.origin + '/');
        } else {
            console.info('socket.io url is: ', connection.socketURL);
        }
    }

    // 我认为这是一个 bug: 调用 io() 函数时需要第二个参数, 否则参数不生效
    try {
        connection.socket = io(connection.socketURL + parameters, connection.socketOptions);
    } catch (e) {
        connection.socket = io.connect(connection.socketURL + parameters, connection.socketOptions);
    }

    // 这个 mPeer 与 MultiPeersHandler.js 相关
    var mPeer = connection.multiPeersHandler;

    // 更新 remoteUserId 的 extra 数据
    connection.socket.on('extra-data-updated', function(remoteUserId, extra) {
        // connection.peers 在 MultiPeersHandler.js 完成初始化操作
        if (!connection.peers[remoteUserId]) return;
        // 更新 extra 数据
        connection.peers[remoteUserId].extra = extra;

        // 调用预设的回调函数
        connection.onExtraDataUpdated({
            userid: remoteUserId,
            extra: extra
        });

        // 同步更新 peersBackup.extra
        updateExtraBackup(remoteUserId, extra);
    });

    // 更新 peersBackup.extra
    function updateExtraBackup(remoteUserId, extra) {
        if (!connection.peersBackup[remoteUserId]) {
            connection.peersBackup[remoteUserId] = {
                userid: remoteUserId,
                extra: {}
            };
        }

        connection.peersBackup[remoteUserId].extra = extra;
    }

    // 监听 connection.socketMessageEvent 事件的处理函数
    function onMessageEvent(message) {
        // 自己不会发消息给自己
        if (message.remoteUserId != connection.userid) return;

        // 更新 connection.peers 和 connection.peersBackup 数据
        if (connection.peers[message.sender] && connection.peers[message.sender].extra != message.message.extra) {
            connection.peers[message.sender].extra = message.extra;
            connection.onExtraDataUpdated({
                userid: message.sender,
                extra: message.extra
            });

            updateExtraBackup(message.sender, message.extra);
        }

        // TODO: 复杂
        if (message.message.streamSyncNeeded && connection.peers[message.sender]) {
            var stream = connection.streamEvents[message.message.streamid];
            if (!stream || !stream.stream) {
                return;
            }

            var action = message.message.action;

            if (action === 'ended' || action === 'inactive' || action === 'stream-removed') {
                if (connection.peersBackup[stream.userid]) {
                    stream.extra = connection.peersBackup[stream.userid].extra;
                }
                connection.onstreamended(stream);
                return;
            }

            var type = message.message.type != 'both' ? message.message.type : null;

            if (typeof stream.stream[action] == 'function') {
                stream.stream[action](type);
            }
            return;
        }

        if (message.message === 'dropPeerConnection') {
            connection.deletePeer(message.sender);
            return;
        }

        if (message.message.allParticipants) {
            // 确保 allParticipants 中添加一个 message.sender
            if (message.message.allParticipants.indexOf(message.sender) === -1) {
                message.message.allParticipants.push(message.sender);
            }

            message.message.allParticipants.forEach(function(participant) {
                mPeer[!connection.peers[participant] ? 'createNewPeer' : 'renegotiatePeer'](participant, {
                    localPeerSdpConstraints: {
                        OfferToReceiveAudio: connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                        OfferToReceiveVideo: connection.sdpConstraints.mandatory.OfferToReceiveVideo
                    },
                    remotePeerSdpConstraints: {
                        OfferToReceiveAudio: connection.session.oneway ? !!connection.session.audio : connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                        OfferToReceiveVideo: connection.session.oneway ? !!connection.session.video || !!connection.session.screen : connection.sdpConstraints.mandatory.OfferToReceiveVideo
                    },
                    isOneWay: !!connection.session.oneway || connection.direction === 'one-way',
                    isDataOnly: isData(connection.session)
                });
            });
            return;
        }

        if (message.message.newParticipant) {
            if (message.message.newParticipant == connection.userid) return;
            if (!!connection.peers[message.message.newParticipant]) return;

            mPeer.createNewPeer(message.message.newParticipant, message.message.userPreferences || {
                localPeerSdpConstraints: {
                    OfferToReceiveAudio: connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                    OfferToReceiveVideo: connection.sdpConstraints.mandatory.OfferToReceiveVideo
                },
                remotePeerSdpConstraints: {
                    OfferToReceiveAudio: connection.session.oneway ? !!connection.session.audio : connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                    OfferToReceiveVideo: connection.session.oneway ? !!connection.session.video || !!connection.session.screen : connection.sdpConstraints.mandatory.OfferToReceiveVideo
                },
                isOneWay: !!connection.session.oneway || connection.direction === 'one-way',
                isDataOnly: isData(connection.session)
            });
            return;
        }

        if (message.message.readyForOffer) {
            if (connection.attachStreams.length) {
                connection.waitingForLocalMedia = false;
            }

            if (connection.waitingForLocalMedia) {
                // if someone is waiting to join you
                // make sure that we've local media before making a handshake
                setTimeout(function() {
                    onMessageEvent(message);
                }, 1);
                return;
            }
        }

        if (message.message.newParticipationRequest && message.sender !== connection.userid) {
            if (connection.peers[message.sender]) {
                connection.deletePeer(message.sender);
            }

            var userPreferences = {
                extra: message.extra || {},
                localPeerSdpConstraints: message.message.remotePeerSdpConstraints || {
                    OfferToReceiveAudio: connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                    OfferToReceiveVideo: connection.sdpConstraints.mandatory.OfferToReceiveVideo
                },
                remotePeerSdpConstraints: message.message.localPeerSdpConstraints || {
                    OfferToReceiveAudio: connection.session.oneway ? !!connection.session.audio : connection.sdpConstraints.mandatory.OfferToReceiveAudio,
                    OfferToReceiveVideo: connection.session.oneway ? !!connection.session.video || !!connection.session.screen : connection.sdpConstraints.mandatory.OfferToReceiveVideo
                },
                isOneWay: typeof message.message.isOneWay !== 'undefined' ? message.message.isOneWay : !!connection.session.oneway || connection.direction === 'one-way',
                isDataOnly: typeof message.message.isDataOnly !== 'undefined' ? message.message.isDataOnly : isData(connection.session),
                dontGetRemoteStream: typeof message.message.isOneWay !== 'undefined' ? message.message.isOneWay : !!connection.session.oneway || connection.direction === 'one-way',
                dontAttachLocalStream: !!message.message.dontGetRemoteStream,
                connectionDescription: message,
                successCallback: function() {}
            };

            connection.onNewParticipant(message.sender, userPreferences);
            return;
        }

        if (message.message.changedUUID) {
            if (connection.peers[message.message.oldUUID]) {
                connection.peers[message.message.newUUID] = connection.peers[message.message.oldUUID];
                delete connection.peers[message.message.oldUUID];
            }
        }

        if (message.message.userLeft) {
            mPeer.onUserLeft(message.sender);

            if (!!message.message.autoCloseEntireSession) {
                connection.leave();
            }

            return;
        }

        mPeer.addNegotiatedMessage(message.message, message.sender);
    }

    connection.socket.on(connection.socketMessageEvent, onMessageEvent);

    // 是否已连接
    var alreadyConnected = false;

    connection.socket.resetProps = function() {
        alreadyConnected = false;
    };

    // 监听 connect 事件
    connection.socket.on('connect', function() {
        // 判断是否已连接
        if (alreadyConnected) {
            return;
        }
        alreadyConnected = true;

        // 打印日志
        if (connection.enableLogs) {
            console.info('socket.io connection is opened.');
        }

        // 上报自己的 extra 数据
        setTimeout(function() {
            connection.socket.emit('extra-data-updated', connection.extra);
        }, 1000);

        // 调用回调函数
        if (connectCallback) {
            connectCallback(connection.socket);
        }
    });

    // 监听 disconnect 事件
    connection.socket.on('disconnect', function(event) {
        connection.onSocketDisconnect(event);
    });

    // 监听 error 事件
    connection.socket.on('error', function(event) {
        connection.onSocketError(event);
    });

    // 监听 user-disconnected 事件
    connection.socket.on('user-disconnected', function(remoteUserId) {
        if (remoteUserId === connection.userid) {
            return;
        }

        connection.onUserStatusChanged({
            userid: remoteUserId,
            status: 'offline',
            extra: connection.peers[remoteUserId] ? connection.peers[remoteUserId].extra || {} : {}
        });

        connection.deletePeer(remoteUserId);
    });

    // 监听 user-connected 事件
    connection.socket.on('user-connected', function(userid) {
        if (userid === connection.userid) {
            return;
        }

        connection.onUserStatusChanged({
            userid: userid,
            status: 'online',
            extra: connection.peers[userid] ? connection.peers[userid].extra || {} : {}
        });
    });

    // 监听 closed-entire-session 事件
    connection.socket.on('closed-entire-session', function(sessionid, extra) {
        connection.leave();
        connection.onEntireSessionClosed({
            sessionid: sessionid,
            userid: sessionid,
            extra: extra
        });
    });

    // 监听 userid-already-taken 事件
    connection.socket.on('userid-already-taken', function(useridAlreadyTaken, yourNewUserId) {
        connection.onUserIdAlreadyTaken(useridAlreadyTaken, yourNewUserId);
    });

    // 监听 logs 事件
    connection.socket.on('logs', function(log) {
        if (!connection.enableLogs) return;
        console.debug('server-logs', log);
    });

    // 监听 number-of-broadcast-viewers-updated 事件
    connection.socket.on('number-of-broadcast-viewers-updated', function(data) {
        connection.onNumberOfBroadcastViewersUpdated(data);
    });

    // 监听 set-isInitiator-true 事件
    connection.socket.on('set-isInitiator-true', function(sessionid) {
        if (sessionid != connection.sessionid) return;
        connection.isInitiator = true;
    });
}
