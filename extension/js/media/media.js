import {settings} from '../settings.js';
import {utils} from '../utils/utils.js';
import {v5Api} from '../api/twitch/v5.js';
import {gqlApi} from '../api/twitch/graphql.js';
import {undocApi} from '../api/twitch/undoc.js';


class Stream{
    constructor(manifestUrl, config){
        this.manifestUrl = manifestUrl;
        const hlsConfig = {};
        Object.assign(hlsConfig, settings.hlsConfig, config);
        this.config = hlsConfig;
    }

    loadHls(videoElem, cb){
        const hls = (this.hls = new Hls(this.config));

        hls.attachMedia(videoElem);
        hls.on(Hls.Events.MEDIA_ATTACHED,() => {
            utils.log("video and hls.js are now bound together !");
            hls.loadSource(this.manifestUrl);
            const manifestParsedHandler = (event, data) => {
                utils.log("manifest loaded, found " + data.levels.length + " quality level");
                this.getClosestLevel(data.levels).then(startLevel=>{
                    hls.startLevel = startLevel;
                    hls.nextLevel = startLevel;
                    cb && cb();
                    hls.startLoad(this.config.startPosition);
                    if(videoElem.paused){
                        videoElem.play()
                        setTimeout(()=>{
                            hls.trigger(Hls.Events.LEVEL_SWITCHED, {
                              level: startLevel,
                            });
                        }, 500);
                    };
                });
                // hls.off(Hls.Events.MANIFEST_PARSED, manifestParsedHandler);
            };
            hls.on(Hls.Events.MANIFEST_PARSED, manifestParsedHandler);
        });
        window.addEventListener("settings.video.playbackSpeed", e=>{
            videoElem.playbackRate = e.detail.value;
        });
    }

    onbufferappended = (fn)=>{
        this.hls.on(Hls.Events.FRAG_BUFFERED, (event, data) =>{
            fn(data.frag.endPTS);
        });
    }

    onlevelchange = fn=>{
        this.qualityUiChangeFn = fn;
        this.hls.on(Hls.Events.LEVEL_SWITCHED, (e, data)=>{
            fn(data.level);
        });
    }

    async getClosestLevel(levels){
        const last = await utils.storage.getItem("lastSetBitrate");
        if(last === "Auto"){
            return -1;
        }
        let index = 0;
        let level, bitrate;
        for(level of levels){
            bitrate = level.bitrate;
            if(bitrate>last){
                return index-1;
            }
            else{
                index++;
            }
        }
        return index-1;
    }
}

class Video{
    constructor(vid){
        this.vid = vid;
    }

    async loadData(){
        const json = await v5Api.video(this.vid);
        this.mutedSegments = json["muted_segments"];
        this.lengthInSecs = json["length"];
        this.lengthInHMS = utils.secsToHMS(this.lengthInSecs);
        this.channel = json["channel"].name;
        this.channelDisplay = json["channel"].display_name;
        this.channelId = json["channel"]._id;
        this.videoStatus = json["status"];
        if(this.videoStatus === "recorded"){
            this.hoverThumbs = await this.loadHoverThumbsInfo(json["seek_previews_url"]);
        }
        this.videoTitle = json["title"];
        this.resolutions = Object.keys(json["resolutions"]);
        utils.log("channel: ", this.channel);
    }

    async loadHoverThumbsInfo(infoUrl){
        if(!infoUrl){
            return
        }
        const json = await utils.fetch(infoUrl);
        if(!json || !json.length) return false;
        let q
        for(q of json){
            if(q.quality === "high"){
                break;
            }
        }
        let urlTemplate = infoUrl.split("/");
        urlTemplate.pop();
        q.urlTemplate = urlTemplate.join("/") + "/";
        return q;
    }

    async makeConfig(){
        let startPosition = parseInt(utils.findGetParameter("time"));
        if(!startPosition){
            startPosition = await utils.storage.getResumePoint(this.vid);
        }
        startPosition = startPosition || 0;
        const volume = await utils.storage.getItem("lastSetVolume");

        const config = {};
        
        config.startPosition = startPosition;
        config.volume = volume || 0.5;

        this.config = config;
    }
}

class Clip{
    constructor(cid){
        this.cid = cid;
    }

    async loadData(){
        let clip = await gqlApi.makeQuery(gqlApi.clipQuery(this.cid));
        clip = clip.data.clip;
        this.title = clip.title;
        this.qualityOptions = clip.videoQualities.map(q=>{
            return {
                "name": q.quality,
                "sourceURL": q.sourceURL,
            };
        });
    }

    async makeConfig(){
        let volume = await utils.storage.getItem("lastSetVolume");
        let lastQuality = await utils.storage.getItem("lastSetQuality");
        let config = {};
        config.startPosition = 0;
        volume = volume || 0.5;
        config.volume = volume;

        let i,q;
        for(i in this.qualityOptions){
            q = this.qualityOptions[i];
            if (lastQuality === q.name){
                config.quality = q;
                config.qualityIdx = i;
                break;
            }
        }
        if(!config.quality){
            config.quality = q;  
            // config.qualityIdx = i;
        } 
        this.config = config;
    }
}


class Live{
    constructor(channel, channelID){
        this.channel = channel;
        this.channelID = channelID;
        this.makeConfig();
    }

    loadData(){
    }

    async makeConfig(){
        const volume = await utils.storage.getItem("lastSetVolume");
        this.config = {volume: volume || 0.5};
    }
    
}

export {Video, Live, Clip, Stream};
