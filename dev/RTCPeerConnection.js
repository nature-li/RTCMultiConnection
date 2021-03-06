// RTCPeerConnection.js

var defaults = {};

function setSdpConstraints(config) {
    var sdpConstraints = {
        OfferToReceiveAudio: !!config.OfferToReceiveAudio,
        OfferToReceiveVideo: !!config.OfferToReceiveVideo
    };

    return sdpConstraints;
}

var RTCPeerConnection;
if (typeof window.RTCPeerConnection !== 'undefined') {
    RTCPeerConnection = window.RTCPeerConnection;
} else if (typeof mozRTCPeerConnection !== 'undefined') {
    RTCPeerConnection = mozRTCPeerConnection;
} else if (typeof webkitRTCPeerConnection !== 'undefined') {
    RTCPeerConnection = webkitRTCPeerConnection;
}

var RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription;
var RTCIceCandidate = window.RTCIceCandidate || window.mozRTCIceCandidate;
var MediaStreamTrack = window.MediaStreamTrack;


// 这个函数(类)的核心成员是 this.peer，即 RTCPeerConnection
// 再加上一些额外的数据
function PeerInitiator(config) {
    // 统一不同浏览器之间的函数定义
    if (typeof window.RTCPeerConnection !== 'undefined') {
        RTCPeerConnection = window.RTCPeerConnection;
    } else if (typeof mozRTCPeerConnection !== 'undefined') {
        RTCPeerConnection = mozRTCPeerConnection;
    } else if (typeof webkitRTCPeerConnection !== 'undefined') {
        RTCPeerConnection = webkitRTCPeerConnection;
    }

    RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription;
    RTCIceCandidate = window.RTCIceCandidate || window.mozRTCIceCandidate;
    MediaStreamTrack = window.MediaStreamTrack;

    if (!RTCPeerConnection) {
        throw 'WebRTC 1.0 (RTCPeerConnection) API are NOT available in this browser.';
    }

    // 获取本端 connection
    var connection = config.rtcMultiConnection;

    // 设置 this 成员
    this.extra = config.remoteSdp ? config.remoteSdp.extra : connection.extra;
    // 这里的 userid 其实是 remoteUserId
    this.userid = config.userid;
    this.streams = [];
    this.channels = config.channels || [];
    this.connectionDescription = config.connectionDescription;

    this.addStream = function(session) {
        connection.addStream(session, self.userid);
    };

    this.removeStream = function(streamid) {
        connection.removeStream(streamid, self.userid);
    };

    var self = this;

    if (config.remoteSdp) {
        this.connectionDescription = config.remoteSdp.connectionDescription;
    }

    // TODO: 不明白这里的意思
    var allRemoteStreams = {};

    defaults.sdpConstraints = setSdpConstraints({
        OfferToReceiveAudio: true,
        OfferToReceiveVideo: true
    });

    /**
     * 最后被设置了 this.peer = peer
     * peer 即 RTCPeerConnection，代表2台计算机之间原生的 WebRTC 连接
     */
    var peer;

    // 注意这里 renegotiatingPeer
    var renegotiatingPeer = !!config.renegotiatingPeer;
    if (config.remoteSdp) {
        renegotiatingPeer = !!config.remoteSdp.renegotiatingPeer;
    }

    var localStreams = [];
    connection.attachStreams.forEach(function(stream) {
        if (!!stream) {
            localStreams.push(stream);
        }
    });

    if (!renegotiatingPeer) {
        var iceTransports = 'all';
        if (connection.candidates.turn || connection.candidates.relay) {
            if (!connection.candidates.stun && !connection.candidates.reflexive && !connection.candidates.host) {
                iceTransports = 'relay';
            }
        }

        try {
            // ref: developer.mozilla.org/en-US/docs/Web/API/RTCConfiguration
            var params = {
                iceServers: connection.iceServers,
                iceTransportPolicy: connection.iceTransportPolicy || iceTransports
            };

            if (typeof connection.iceCandidatePoolSize !== 'undefined') {
                params.iceCandidatePoolSize = connection.iceCandidatePoolSize;
            }

            if (typeof connection.bundlePolicy !== 'undefined') {
                params.bundlePolicy = connection.bundlePolicy;
            }

            if (typeof connection.rtcpMuxPolicy !== 'undefined') {
                params.rtcpMuxPolicy = connection.rtcpMuxPolicy;
            }

            if (!!connection.sdpSemantics) {
                params.sdpSemantics = connection.sdpSemantics || 'unified-plan';
            }

            if (!connection.iceServers || !connection.iceServers.length) {
                params = null;
                connection.optionalArgument = null;
            }

            peer = new RTCPeerConnection(params, connection.optionalArgument);
        } catch (e) {
            try {
                var params = {
                    iceServers: connection.iceServers
                };

                peer = new RTCPeerConnection(params);
            } catch (e) {
                peer = new RTCPeerConnection();
            }
        }
    } else {
        peer = config.peerRef;
    }

    if (!peer.getRemoteStreams && peer.getReceivers) {
        peer.getRemoteStreams = function() {
            var stream = new MediaStream();
            peer.getReceivers().forEach(function(receiver) {
                stream.addTrack(receiver.track);
            });
            return [stream];
        };
    }

    if (!peer.getLocalStreams && peer.getSenders) {
        peer.getLocalStreams = function() {
            var stream = new MediaStream();
            // getSenders(）是 RTCPeerConnection 的原生函数
            // 这个函数返回的是 [RTCRtpSender]
            // 每一个 RTCRtpSender有一个 track 可读属性
            peer.getSenders().forEach(function(sender) {
                // addTrack 为 MediaStream 的原生函数
                stream.addTrack(sender.track);
            });
            return [stream];
        };
    }

    // ICE 层收集到的所有网络连接信息，收到信息后应该通过信令服务器转发给对端
    peer.onicecandidate = function(event) {
        // 本函数会收到每个 candidate, 当 event.candidate 为 null时，表明 candidate 已经收集结束了
        // 详情参见：https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling
        if (!event.candidate) {
            // trickle 代表不用等待完全收集、交换完 candidate 后，再交换 sdp
            if (!connection.trickleIce) {
                // RTCSessionDescription 定义参考：
                // https://developer.mozilla.org/en-US/docs/Web/API/RTCSessionDescription
                var localSdp = peer.localDescription;
                config.onLocalSdp({
                    // type 值可以为: offer answer pranswer rollback
                    type: localSdp.type,
                    sdp: localSdp.sdp,
                    remotePeerSdpConstraints: config.remotePeerSdpConstraints || false,
                    renegotiatingPeer: !!config.renegotiatingPeer || false,
                    connectionDescription: self.connectionDescription,
                    dontGetRemoteStream: !!config.dontGetRemoteStream,
                    extra: connection ? connection.extra : {},
                    streamsToShare: streamsToShare
                });
            }
            return;
        }

        // candidate 全部收集完成后再交换 sdp
        // 默认 trickle 为 true, 即不会直接返回
        if (!connection.trickleIce) return;

        config.onLocalCandidate({
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
        });
    };

    localStreams.forEach(function(localStream) {
        if (config.remoteSdp && config.remoteSdp.remotePeerSdpConstraints && config.remoteSdp.remotePeerSdpConstraints.dontGetRemoteStream) {
            return;
        }

        if (config.dontAttachLocalStream) {
            return;
        }

        localStream = connection.beforeAddingStream(localStream, self);

        if (!localStream) return;

        peer.getLocalStreams().forEach(function(stream) {
            if (localStream && stream.id == localStream.id) {
                localStream = null;
            }
        });

        if (localStream && localStream.getTracks) {
            localStream.getTracks().forEach(function(track) {
                try {
                    // last parameter is redundant for unified-plan
                    // starting from chrome version 72
                    peer.addTrack(track, localStream);
                } catch (e) {}
            });
        }
    });

    // 当任一网络环境发生变化时，调用此函数
    // 可以通过 RTCPeerConnection.connectionState 查看最新网络状态
    // setLocalDescription 或 setRemoteDescription 调用时，会触发 onsignalingstatechange 事件
    // 可以通过 RTCPeerConnection.signalingState 查看最新状态
    peer.oniceconnectionstatechange = peer.onsignalingstatechange = function() {
        // 获取 remoteUserId 的 extra 数据
        var extra = self.extra;
        if (connection.peers[self.userid]) {
            extra = connection.peers[self.userid].extra || extra;
        }

        if (!peer) {
            return;
        }

        // connection.onPeerStateChanged 的默认操作是打印一条日志
        config.onPeerStateChanged({
            iceConnectionState: peer.iceConnectionState,
            iceGatheringState: peer.iceGatheringState,
            signalingState: peer.signalingState,
            extra: extra,
            userid: self.userid
        });

        // iceConnectionState 为 RTCPeerConnection 的属性
        // 其值为字符串，可以是: new, checking, connected, completed, failed, disconnected, closed
        if (peer && peer.iceConnectionState && peer.iceConnectionState.search(/closed|failed/gi) !== -1 && self.streams instanceof Array) {
            self.streams.forEach(function(stream) {
                var streamEvent = connection.streamEvents[stream.id] || {
                    streamid: stream.id,
                    stream: stream,
                    type: 'remote'
                };

                // 调用回调函数
                connection.onstreamended(streamEvent);
            });
        }
    };

    var sdpConstraints = {
        OfferToReceiveAudio: !!localStreams.length,
        OfferToReceiveVideo: !!localStreams.length
    };

    if (config.localPeerSdpConstraints) sdpConstraints = config.localPeerSdpConstraints;

    defaults.sdpConstraints = setSdpConstraints(sdpConstraints);

    var streamObject;
    var dontDuplicate = {};

    // event 为 RTCTrackEvent 类型
    peer.ontrack = function(event) {
        if (!event || event.type !== 'track') return;

        // 获取列表中最后一个 stream
        event.stream = event.streams[event.streams.length - 1];

        if (!event.stream.id) {
            event.stream.id = event.track.id;
        }

        // 避免 onended 添加2次
        if (dontDuplicate[event.stream.id] && DetectRTC.browser.name !== 'Safari') {
            if (event.track) {
                // 添加 RTCTrackEvent 时，就添加好 remove 方法
                event.track.onended = function() { // event.track.onmute = 
                    peer && peer.onremovestream(event);
                };
            }
            return;
        }

        dontDuplicate[event.stream.id] = event.stream.id;

        var streamsToShare = {};
        if (config.remoteSdp && config.remoteSdp.streamsToShare) {
            streamsToShare = config.remoteSdp.streamsToShare;
        } else if (config.streamsToShare) {
            streamsToShare = config.streamsToShare;
        }

        var streamToShare = streamsToShare[event.stream.id];

        // isAudio isVideo isScreen 是在 MediaStream 基础上作者新添加几个属性
        if (streamToShare) {
            event.stream.isAudio = streamToShare.isAudio;
            event.stream.isVideo = streamToShare.isVideo;
            event.stream.isScreen = streamToShare.isScreen;
        } else {
            event.stream.isVideo = !!getTracks(event.stream, 'video').length;
            event.stream.isAudio = !event.stream.isVideo;
            event.stream.isScreen = false;
        }

        // streamid 也是新添加的属性
        event.stream.streamid = event.stream.id;

        allRemoteStreams[event.stream.id] = event.stream;
        // 不懂这个回调函数作用
        config.onRemoteStream(event.stream);

        // 添加 RTCTrackEvent 时，就添加好 remove 方法
        event.stream.getTracks().forEach(function(track) {
            track.onended = function() { // track.onmute = 
                peer && peer.onremovestream(event);
            };
        });

        // MediaStream 的原生事件 onremovetrack
        // 当 MediaStreamTrack 被 remove 时触发
        event.stream.onremovetrack = function() {
            peer && peer.onremovestream(event);
        };
    };

    peer.onremovestream = function(event) {
        // this event doesn't works anymore
        event.stream.streamid = event.stream.id;

        if (allRemoteStreams[event.stream.id]) {
            delete allRemoteStreams[event.stream.id];
        }

        config.onRemoteStreamRemoved(event.stream);
    };

    if (typeof peer.removeStream !== 'function') {
        // removeStream backward compatibility
        peer.removeStream = function(stream) {
            stream.getTracks().forEach(function(track) {
                peer.removeTrack(track, stream);
            });
        };
    }

    this.addRemoteCandidate = function(remoteCandidate) {
        peer.addIceCandidate(new RTCIceCandidate(remoteCandidate));
    };

    function oldAddRemoteSdp(remoteSdp, cb) {
        cb = cb || function() {};

        if (DetectRTC.browser.name !== 'Safari') {
            remoteSdp.sdp = connection.processSdp(remoteSdp.sdp);
        }
        peer.setRemoteDescription(new RTCSessionDescription(remoteSdp), cb, function(error) {
            if (!!connection.enableLogs) {
                console.error('setRemoteDescription failed', '\n', error, '\n', remoteSdp.sdp);
            }

            cb();
        });
    }

    this.addRemoteSdp = function(remoteSdp, cb) {
        cb = cb || function() {};

        if (DetectRTC.browser.name !== 'Safari') {
            remoteSdp.sdp = connection.processSdp(remoteSdp.sdp);
        }

        peer.setRemoteDescription(new RTCSessionDescription(remoteSdp)).then(cb, function(error) {
            if (!!connection.enableLogs) {
                console.error('setRemoteDescription failed', '\n', error, '\n', remoteSdp.sdp);
            }

            cb();
        }).catch(function(error) {
            if (!!connection.enableLogs) {
                console.error('setRemoteDescription failed', '\n', error, '\n', remoteSdp.sdp);
            }

            cb();
        });
    };

    // 猜测意思为: 本端是否 offer 发起者
    var isOfferer = true;
    if (config.remoteSdp) {
        isOfferer = false;
    }

    this.createDataChannel = function() {
        // 这里是原生的 createDataChannel 函数
        // 用法详情见这里：https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel
        var channel = peer.createDataChannel('sctp', {});
        setChannelEvents(channel);
    };

    if (connection.session.data === true && !renegotiatingPeer) {
        if (!isOfferer) {
            peer.ondatachannel = function(event) {
                var channel = event.channel;
                setChannelEvents(channel);
            };
        } else {
            this.createDataChannel();
        }
    }

    this.enableDisableVideoEncoding = function(enable) {
        var rtcp;
        peer.getSenders().forEach(function(sender) {
            if (!rtcp && sender.track.kind === 'video') {
                rtcp = sender;
            }
        });

        if (!rtcp || !rtcp.getParameters) return;

        var parameters = rtcp.getParameters();
        parameters.encodings[1] && (parameters.encodings[1].active = !!enable);
        parameters.encodings[2] && (parameters.encodings[2].active = !!enable);
        rtcp.setParameters(parameters);
    };

    if (config.remoteSdp) {
        if (config.remoteSdp.remotePeerSdpConstraints) {
            sdpConstraints = config.remoteSdp.remotePeerSdpConstraints;
        }
        defaults.sdpConstraints = setSdpConstraints(sdpConstraints);
        this.addRemoteSdp(config.remoteSdp, function() {
            // 创建 answer
            createOfferOrAnswer('createAnswer');
        });
    }

    function setChannelEvents(channel) {
        // force ArrayBuffer in Firefox; which uses "Blob" by default.
        channel.binaryType = 'arraybuffer';

        // RTCDataChannel 可以监听各种事件
        channel.onmessage = function(event) {
            config.onDataChannelMessage(event.data);
        };

        channel.onopen = function() {
            config.onDataChannelOpened(channel);
        };

        channel.onerror = function(error) {
            config.onDataChannelError(error);
        };

        channel.onclose = function(event) {
            config.onDataChannelClosed(event);
        };

        channel.internalSend = channel.send;
        channel.send = function(data) {
            if (channel.readyState !== 'open') {
                return;
            }

            channel.internalSend(data);
        };

        peer.channel = channel;
    }

    if (connection.session.audio == 'two-way' || connection.session.video == 'two-way' || connection.session.screen == 'two-way') {
        defaults.sdpConstraints = setSdpConstraints({
            OfferToReceiveAudio: connection.session.audio == 'two-way' || (config.remoteSdp && config.remoteSdp.remotePeerSdpConstraints && config.remoteSdp.remotePeerSdpConstraints.OfferToReceiveAudio),
            OfferToReceiveVideo: connection.session.video == 'two-way' || connection.session.screen == 'two-way' || (config.remoteSdp && config.remoteSdp.remotePeerSdpConstraints && config.remoteSdp.remotePeerSdpConstraints.OfferToReceiveAudio)
        });
    }

    var streamsToShare = {};
    peer.getLocalStreams().forEach(function(stream) {
        streamsToShare[stream.streamid] = {
            isAudio: !!stream.isAudio,
            isVideo: !!stream.isVideo,
            isScreen: !!stream.isScreen
        };
    });

    function oldCreateOfferOrAnswer(_method) {
        peer[_method](function(localSdp) {
            if (DetectRTC.browser.name !== 'Safari') {
                localSdp.sdp = connection.processSdp(localSdp.sdp);
            }
            peer.setLocalDescription(localSdp, function() {
                if (!connection.trickleIce) return;

                config.onLocalSdp({
                    type: localSdp.type,
                    sdp: localSdp.sdp,
                    remotePeerSdpConstraints: config.remotePeerSdpConstraints || false,
                    renegotiatingPeer: !!config.renegotiatingPeer || false,
                    connectionDescription: self.connectionDescription,
                    dontGetRemoteStream: !!config.dontGetRemoteStream,
                    extra: connection ? connection.extra : {},
                    streamsToShare: streamsToShare
                });

                connection.onSettingLocalDescription(self);
            }, function(error) {
                if (!!connection.enableLogs) {
                    console.error('setLocalDescription-error', error);
                }
            });
        }, function(error) {
            if (!!connection.enableLogs) {
                console.error('sdp-' + _method + '-error', error);
            }
        }, defaults.sdpConstraints);
    }

    // 用参数来区分是 createOffer 还是 createAnswer
    // createOffer 和 createAnswer 是 RTCPeerConnection 的方法
    function createOfferOrAnswer(_method) {
        peer[_method](defaults.sdpConstraints).then(function(localSdp) {
            if (DetectRTC.browser.name !== 'Safari') {
                localSdp.sdp = connection.processSdp(localSdp.sdp);
            }
            peer.setLocalDescription(localSdp).then(function() {
                if (!connection.trickleIce) return;

                // 与对端交换 sdp 信息
                config.onLocalSdp({
                    type: localSdp.type,
                    sdp: localSdp.sdp,
                    remotePeerSdpConstraints: config.remotePeerSdpConstraints || false,
                    renegotiatingPeer: !!config.renegotiatingPeer || false,
                    connectionDescription: self.connectionDescription,
                    dontGetRemoteStream: !!config.dontGetRemoteStream,
                    extra: connection ? connection.extra : {},
                    streamsToShare: streamsToShare
                });

                connection.onSettingLocalDescription(self);
            }, function(error) {
                if (!connection.enableLogs) return;
                console.error('setLocalDescription error', error);
            });
        }, function(error) {
            if (!!connection.enableLogs) {
                console.error('sdp-error', error);
            }
        });
    }

    if (isOfferer) {
        // 创建 offer
        createOfferOrAnswer('createOffer');
    }

    peer.nativeClose = peer.close;
    peer.close = function() {
        if (!peer) {
            return;
        }

        try {
            if (peer.nativeClose !== peer.close) {
                peer.nativeClose();
            }
        } catch (e) {}

        peer = null;
        self.peer = null;
    };

    this.peer = peer;
}
