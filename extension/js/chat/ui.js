import {settings} from '../settings.js';
import {ReChat, LiveChat} from './chat.js';
import {colors} from './colors.js';
import {utils} from '../utils/utils.js';
import {Emotes} from './emotes.js';
import {Draggable, Resizable} from '../utils/moveresize.js';
import {gqlApi} from '../api/twitch/graphql.js';



class MessageCompressor{
    constructor(){
        this.minCompressLength = 20;
    }

    shouldDoCompression(multiplier, arr){
        return multiplier > 1 && multiplier * arr.reduce((acc, f) => {
            if(f.emoticon){
                return acc+2; // assume emotes have a width of 2 characters
            }
            return acc+f.text.length;
        }, 0) >= this.minCompressLength;
    }

    doCompression(multiplier, arr, target){
        target.push({
            "text": "",
            "type": "repeatingSegmentStart",
            "amount": multiplier,
        });
        target.push(...arr);
        target.push({
            "text": "",
            "type": "repeatingSegmentEnd",
            "amount": multiplier,
        });
    }

    fragmentArrayStartsWith(arr, includedArr){
        let idx = 0;
        for(idx in includedArr){
            if(arr[idx].text !== includedArr[idx].text){
                return false;
            }
        }
        return true;
    }

    getRepeatingFragments(headIdx, msgFragments){
        const repeatingFragments = [msgFragments[headIdx]];
        let repL = repeatingFragments.length;
        const msgL = msgFragments.length - headIdx;

        let multiplier = 1;
        let fragmentIdx = headIdx+1;
        let fragment;

        while(repL * (multiplier + 1) <= msgL){
            if (this.fragmentArrayStartsWith(
                msgFragments.slice(fragmentIdx, fragmentIdx+repL), repeatingFragments)
            ){
                multiplier++;
                fragmentIdx += repL;
            }
            else{
                if(multiplier > 1){
                    break;
                }
                else{
                    repeatingFragments.push(msgFragments[fragmentIdx++]);
                }
            }

            repL = repeatingFragments.length;
        }


        return [repeatingFragments, multiplier];
        // possible results:
        // 1. find repeats and then message ends
        // 2. finds repeats and then a fragment that doesnt fit
        // 3. finds no repeats and repeatingFragments.length * (multiplier+1) > msgL

    }

    compressMessage(msg){
        const msgFragments = msg.fragments;
        const msgFragmentsL = msgFragments.length;
        const fragments = [];

        let msgFragmentHeadIdx = 0;
        let multiplier;
        let repeatingFragments;

        while(true){
            if (msgFragmentHeadIdx == msgFragmentsL-1){
                fragments.push(msgFragments[msgFragmentHeadIdx]);
                break;
            }
            else if (msgFragmentHeadIdx > msgFragmentsL-1){
                break;
            }
            [repeatingFragments, multiplier] = this.getRepeatingFragments(
                msgFragmentHeadIdx,
                msgFragments
            );
            if (multiplier === 1){ // didnt find any repeats; move head one step further
                fragments.push(msgFragments[msgFragmentHeadIdx]);
                msgFragmentHeadIdx++;
            }
            else{
                msgFragmentHeadIdx = msgFragmentHeadIdx + repeatingFragments.length * multiplier;
                this.doCompression(multiplier, repeatingFragments, fragments);
            }
        }
        msg.fragments = fragments;
    }
}

const messageCompressor = new MessageCompressor();

class ChatInterface{
    constructor(details){

        this.elem = details.chatElem;
        this.channel = details.channel;
        this.channelId = details.channelId;
        this.chatonly = utils.findGetParameter("chatonly");
        this.chatCont = this.elem.querySelector(".chat-container");
        this.chatPausedIndicator = this.chatCont.querySelector(".chat-paused-indicator");
        this.chatLines = this.chatCont.querySelector(".chat-lines");
        this.chatOptionsElem = this.elem.querySelector(".chat-options");
        this.hiddenIndicator = this.elem.querySelector(".hidden-indicator");
        
        this.emotes = new Emotes();

        this.restoreChat();

        this.initMoveDrag();

        this.badges = {
            "moderator": "/resources/badges/mod.png",
            "staff": "/resources/badges/staff.png",
            "vip": "/resources/badges/vip.png",
            "partner": "/resources/badges/partner.png",
            "broadcaster": "/resources/badges/broadcaster.png",
        }

        this.autoScroll = true;

        this.handlers();

        // initial settings values:
        this.syncTime = 0;

        this.filters = {
            users: new Set(),
            phrases: [],
            regexes: [],
        }

        this.hiddenCount = 0;
    }

    handlers(){
        setInterval(()=>{
            if (this.hiddenCount > 0){
                this.hiddenIndicator.textContent = this.hiddenCount;
                this.hiddenIndicator.style.opacity = "1";
                setTimeout(()=>{
                    this.hiddenIndicator.style.opacity = "0";
                }, 2000);
                this.hiddenCount = 0;
            }
        }, 4000);

        window.addEventListener("settings.chat.filters", e=>{
            const filters = e.detail.value;
            const users = new Set();
            const regexes = [];
            const phrases = [];
            let type, value;
            for({type, value} of filters){
                switch(type){
                    case "user":
                        users.add(value);
                        break;
                    case "phrase":
                        phrases.push(value);
                        break;
                    case "regex":
                        try{
                            regexes.push(new RegExp(value));
                        }
                        catch(err){
                            
                        }
                        break;
                }
            }
            this.filters = {
                users,
                regexes,
                phrases,
            };
        });

        window.addEventListener("settings.chat.fontSize", e=>{
            this.chatCont.style.fontSize = e.detail.value+"px";
        });
        window.addEventListener("settings.chat.bgVisibility", e=>{
            let val = e.detail.value;
            val = val / 100;
            this.chatCont.style.backgroundColor = `rgba(41,41,41, ${val})`;
        });
        window.addEventListener("settings.chat.syncTime", e=>{
            this.syncTime = e.detail.value;
        });

        window.addEventListener("settings.chat.compressRepeatingPhrases", e=>{
            this.compressRepeatingPhrases = e.detail.value;
        });

        window.addEventListener("settings.chat.trimLongMessages", e=>{
            this.trimLongMessages = e.detail.value;
        });

        window.onresize = (event) => {
            this.scrollToBottom();
        }

        if(this.chatonly){
            return;
        }

        this.chatCont.addEventListener("mouseenter", (e) => {
            this.autoScroll = false;
            this.chatPausedIndicator.style.display = "block";
        });
        this.chatCont.addEventListener("mouseleave", (e) => {
            this.autoScroll = true;
            this.chatPausedIndicator.style.display = "none";
        });

        this.chatLines.addEventListener("click", e=>{

            if(e.target.classList.contains("msg-more-tooltip")){
                e.target.nextElementSibling.classList.remove("hidden");
                e.target.classList.add("hidden");
            }
        });


        document.addEventListener("keydown", e=>{
            if(e.shiftKey || e.altKey || e.ctrlKey)return;
            if(e.key === "c"){
                this.toggleChat();
            }
        });

    }

    restoreChat(){
        if(this.chatonly){
            this.elem.style.width = "100%";
            this.elem.style.height = "100%";
            this.elem.style.left = "0";
            this.elem.style.top = "0";
            this.elem.style.display = "block";
            this.elem.querySelector(".drag-handle").style.display = "none";
            this.elem.querySelector(".resize-handle").style.display = "none";
        }
        else{
            const promises = [
                utils.storage.getItem("lastChatDim").then(dim=>{
                    if(dim){
                        this.elem.style.width = dim.width;
                        this.elem.style.height = dim.height;
                    }
                }),
                utils.storage.getItem("lastChatPos").then(pos=>{
                    if(pos){
                        this.elem.style.left = pos.left;
                        this.elem.style.top = pos.top;
                    }
                }),
            ];
            Promise.all(promises).then(e=>{
                this.elem.style.display = "block";
            });
        }
    }

    queueStart(vid, channel, channelId){
    }

    start(channel, channelId, offset=0){
    }

    getSubBadge(channel){
        if(!channel){return;}
        gqlApi.badges(channel).then(badge=>{
            if(badge){
                this.badges["subscriber"] = badge["image1x"];
            }
        });
    }

    iterate(secs){
        if(this.addingMsgs || this.seeking)return;
        this.addNewMsgs(secs);
        this.chat.getNext();
    }

    msgElem(msg){
        let elem  = document.createElement("div");
        elem.classList.add("message");
        let color = msg.color && msg.color.toLowerCase();
        if(color && color.length){
            color = colors.convertColor(color);
        }
        else{
            color = "#C4BBBF";
        }
        const parts = [];
        let fragment, emote;
        for(fragment of msg.fragments){
            const text = fragment.text;
            if (text.startsWith("https://")){
                parts.push(`<a target="_blank" href="${text}">${text}</a>`);
            }
            else if(fragment.type === "repeatingSegmentStart"){
                parts.push("<span class='repeating-phrase'>");
            }
            else if(fragment.type === "repeatingSegmentEnd"){
                parts.push(`<span class='repeating-amount'>x${fragment.amount}</span></span>`);
            }
            else{
                emote = this.emotes.getEmoteFromFragment(fragment);
                if(emote){
                    parts.push(emote);
                }
                else{
                    parts.push(text);
                }
            }
        }
        if (this.trimLongMessages){
            if(parts.length > 15){
                const rest = parts.splice(12);
                parts.push(`<span title="Show whole message" class="msg-more-tooltip">...</span><span class="hidden">${rest.join(" ")}</span>`);
                // parts.push(`<span title="${rest.join(" ");}" class='msg-more-tooltip'>...</span>`);
            }
        }
        const text = parts.join(" ");

        let badges = "";
        if(msg.badges){
            badges = this.getBadgeElems(msg.badges);
        }
        elem.innerHTML = `${badges}<span style="color:${color};" class="from">${msg.from}: </span><span class="text">${text}</span>`;
        return elem;
    }

    addMsg(msg){
        if (this.msgIsHidden(msg)) {
            this.hiddenCount++;
            return;
        }
        if (this.compressRepeatingPhrases){
            messageCompressor.compressMessage(msg);
        }
        let elem = msg.elem;
        if(!elem){
            elem = this.msgElem(msg);
            msg.elem = elem;
        }
        this.chatLines.appendChild(elem);
    }

    msgIsHidden(msg){
        if (this.filters.users.has(msg.from.toLowerCase())){
            return true;
        }

        let s;
        for (s of this.filters.regexes){
            if (s.test(msg.body)) return true;
        }
        for (s of this.filters.phrases){
            if (msg.body.indexOf(s)>=0) return true;
        }
        return false;
    }

    addNewMsgs(time){
        this.addingMsgs = true;
        let msg = this.chat.messages.get(0);
        while (msg !== undefined){
            if (msg.time <= time){
                this.addMsg(msg);
                msg = this.chat.messages.shift();
            }
            else{
                break;
            }
        }

        this.removeOldLines()
        if(this.autoScroll){
            this.scrollToBottom();
        }
        this.addingMsgs = false;
    }

    getBadgeElem(name, path){
        let className = `badge-img ${name}-badge`;
        return `<img src="${path}" title="${name}" class="${className}">`;
    }

    getBadgeElems(badges){
        let elems = [], name, def;
        for(def of badges){
            name = def._id;
            if(name in this.badges){
                elems.push(this.getBadgeElem(name, this.badges[name]));
            }
        }
        if(elems.length){
            return `<span class="user-badges">${elems.join("")}</span>`;
        }
        return "";
    }

    removeOldLines(){
        let elems = this.chatLines.children;
        if (elems.length > 200){
            let i = 0;
            while (i < 100){
                elems[0].remove();
                i++;
            }
        }
    }

    scrollToBottom(){
        this.chatCont.scrollTo(0,this.chatCont.scrollHeight);
    }


    clearMessages(){
        this.chatLines.innerHTML = "";
    }

    initMoveDrag(){
        let draggableConfig = {
            outer: document.querySelector(".app"),
            handle: document.querySelector(".drag-handle"),
            onEnd: ()=>{
                utils.storage.setItem("lastChatPos", {"left":this.elem.style.left, "top": this.elem.style.top});
            }
        }
        this.draggable = new Draggable(this.elem, draggableConfig);
        this.draggable.init();

        let resizableConfig = {
            outer: document.querySelector(".app"),
            handle: document.querySelector(".resize-handle"),
            onEnd: ()=>{
                utils.storage.setItem("lastChatDim", {
                    "width": this.elem.style.width,
                    "height": this.elem.style.height
                });
            }
        }
        this.resizable = new Resizable(this.elem, resizableConfig);
        this.resizable.init();
    }
    toggleChat(){
        let current = this.elem.style.display;
        if(current === "none"){
            this.elem.style.display = "block";
            this.scrollToBottom();
        }
        else this.elem.style.display = "none";
    }

}



class ReChatInterface extends ChatInterface{
    constructor(details){
        super(details);
        this.chat = new ReChat(details.videoId);
        this.timeGiver = details.timeGiver;
        this.iterateInterval = 200;
    }
    start(offset=0){
        this.previousTime = offset;
        this.chat.start(offset);
        this.getSubBadge(this.channel);
        this.emotes.loadEmoteData(this.channel, this.channelId);
        this.iterate();
    }

    updateChatPosition(currentTime, previousTime){
        // const chatTime = secs + this.syncTime;
        const diff = currentTime - previousTime;
        if(-33 < diff && diff < 0){
            const success = this.revertUntilAlign(currentTime);
            if(!success) this.chat.seek(currentTime);
        }
        else if(0 < diff && diff < 33){
            this.addNewMsgs(currentTime);
        }
        else if (diff == 0) return;
        else{
            this.chat.seek(currentTime);
            this.clearMessages();
        }
        this.chat.getNext();
    }

    revertUntilAlign(secs){
        let shifted, msg;
        while (true){
            shifted = this.chat.messages.revertShift();
            msg = this.chat.messages.get(0);
            if(!shifted || !msg){
                return false;
            }
            if(msg.time <= secs){
                this.chat.messages.advanceStart();
                return true;
            }
            else{
                try{
                    msg.elem.remove();
                }
                catch(e){

                }
                // if(this.chatLines.contains(msg.elem)){
                // }
            }
        }
    }

    iterate = ()=>{
        const newTime = this.timeGiver() + this.syncTime;
        this.updateChatPosition(newTime, this.previousTime);
        this.previousTime = newTime;
        // this.chat.getNext();
        setTimeout(this.iterate, this.iterateInterval);
    }
}


class LiveChatInterface extends ChatInterface{
    constructor(details){
        super(details);
        this.chat = new LiveChat(details.channel);
    }
    start(){
        this.chat.start(this.onMsg.bind(this));
        this.getSubBadge(this.channel);
        this.emotes.loadEmoteData(this.channel, this.channelId);
        this.iterate();
    }

    seek(){
        
    }

    onMsg(msg){
        this.addMsg(msg);
    }

    getBadgeElems(badges){
        let elems = [], badge;
        for(badge of badges){
            if(badge in this.badges){
                elems.push(this.getBadgeElem(badge, this.badges[badge]));
            }
        }
        if(elems.length){
            return `<span class="user-badges">${elems.join("")}</span>`;
        }
        return "";
    }

    iterate = ()=>{
        this.removeOldLines();
        if(this.autoScroll){
            this.scrollToBottom();
        }
        setTimeout(this.iterate, 300);
    }
}


export {ReChatInterface, LiveChatInterface};
