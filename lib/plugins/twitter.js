/* twitter.js - plugin for handling real-time communications with Twitter */
var twitobj = require('twitter'),
    levenshtein = require('levenshtein'),
    unshortener = require('unshortener'),
    Bitly = require('bitly').Bitly,
    async = require('async'),
    util = require('util');
    
var twitter = exports,
    match = new RegExp(/(http|https):\/\/(\w+:{0,1}\w*@)?(\S+)(:[0-9]+)?(\/|\/([\w#!:.?+=&%@!\-\/]))?/g);



twitter.start = function (client, config){

  if (!config.auth.bitly.key) {
    console.log("warn: bitly API credentials not detected.  Shortlinks to tweets will not be added.".magenta);
  }
  else {
    twitter.bitly = new Bitly(config.auth.bitly.user, config.auth.bitly.key);
  }
  if ((!config.auth.twitter.access_token_key)&&(!config.auth.twitter.consumer_key)) {
    console.log("warn: twitter credentials not detected, disabling Twitter functionality".magenta);
  } 
  else {
    twit = new twitobj(config.auth.twitter); 
    twit.verifyCredentials(function (data) {
      if (data.statusCode != 200) {
        console.log("err: twitter credentials have been rejected by the Twitter API.".red);
        console.log("Error Status Code".red, data.statusCode);
      }
      else if ((!config.plugins.twitter.userid)||(data.id != config.plugins.twitter.userid)) {
        console.log('info: Twitter has verified new user ID: '.cyan, data.id_str);
        config.plugins.twitter.userid = data.id;
      }
    });
  }
  
  Object.getOwnPropertyNames(config.plugins.irc.channels).forEach( function(channel, index) {
    config.plugins.irc.channels[channel].currentTweetCount = 0;
  });
  
  setInterval(function () {
    Object.getOwnPropertyNames(config.plugins.irc.channels).forEach( function(channel, index) {
      if (config.plugins.irc.channels[channel].currentTweetCount > 0) {
        config.plugins.irc.channels[channel].currentTweetCount--;
      }
    });
  }, 120000);
  
  Object.getOwnPropertyNames(config.plugins.irc.channels).forEach( function(channel, index) {
    twitter.rateListener(client, config, channel);
  });
  
  client.on("userjoin", function (channel) {
    twitter.rateListener(client, config, channel);
  });
  
  client.once("join", function (channel, nick) {
    
    // TODO: remove this typeof check
    // we should have knowledge of the current state of the twitter plugin
    if(typeof twit !== 'undefined'){

      try {
        console.log("info: attempting connection to Twitter stream API...".grey)
        twit.stream('statuses/filter', {track:config.plugins.twitter.track, follow:config.plugins.twitter.userid}, function(stream) {
          console.log("info: connection successful.  Awaiting tweets...".green)
          stream.on('data', function (data) {
            var tweetChannels = [],
                tooClose = false,
                matched = 0,
                found;
            if((data.text)&&((!(/.*\bRT:?.*/i).test(data.text))&&(!data.retweeted)&&(data.user.lang == "en"))) {
              var tweetURL = "http://twitter.com/#!/"+data.user.screen_name+"/status/"+data.id_str,
                  tweetMsg = "@" + data.user.screen_name + " " + data.text;
              tweetMsg = tweetMsg.replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
              if(data.in_reply_to_user_id_str == config.plugins.twitter.userid) {
                config.channels.forEach(function (channel, index) {
                  tweetChannels.push(channel);
                });
                twitter.sayTweet(client, config, tweetMsg, tweetURL, tweetChannels);
              }
              else {
                if (config.plugins.twitter.recentTweets.length > 0) {
                  config.plugins.twitter.recentTweets.forEach( function (tweet, index) {
                    var lev = new levenshtein(data.text, tweet);
                    if (lev.distance < config.plugins.twitter.filter) {
                      tooClose = true;
                    }
                  });
                }
                if (config.plugins.twitter.recentUrls.length > 0) {
                  found = tweetMsg.match(match);
                  while (found && (found.length > 0)) {
                    var filtered = config.plugins.twitter.recentUrls.filter(function(v) { if (v === found[0]) return true; });
                    matched += filtered.length;
                  }
                }
                if ((!tooClose) && (matched < config.plugins.twitter.recentCount)) {
                  config.channels.forEach(function (channel, index) {
                    if (((config.plugins.irc.channels[channel].volume / 2) > config.plugins.irc.channels[channel].currentTweetCount)||(config.plugins.irc.channels[channel].volume == 11)) {
                      tweetChannels.push(channel);
                    }
                  });
                  twitter.sayTweet(client, config, tweetMsg, tweetURL, tweetChannels);
                }
                else {
                  console.log("Tweet suppressed: ", tweetMsg);
                }
              }//console.log("@" + data.user.screen_name + ": " + data.text)
            }
          });
        });
      }
      catch(error) { 
        // Squash error for now
        // TODO: throw error somewhere it can be caught
        //console.log(error.stack); 
      }
      
    }
  });
}


twitter.rateListener = function (client, config, channel) {
  client.on("rateChange"+channel, function (channel, rate) {
    if (config.plugins.irc.channels[channel].volume != 11) {
      if (rate > 10) {
        rate = 10;
      }  
      if ((config.plugins.irc.channels[channel].volume < 0)||(typeof config.plugins.irc.channels[channel].volume === 'undefined')) { 
        config.plugins.irc.channels[channel].volume = 0;
      }
      if ((10 - rate) <= config.plugins.irc.channels[channel].volume) {
        config.plugins.irc.channels[channel].volume = 10 - rate;
        config.plugins.irc.channels[channel].lastVolume = config.plugins.irc.channels[channel].volume;
      }
      else if ((10 - rate) > config.plugins.irc.channels[channel].volume ) {
        config.plugins.irc.channels[channel].lastVolume = config.plugins.irc.channels[channel].lastVolume + 0.05;
        config.plugins.irc.channels[channel].volume = Math.round(config.plugins.irc.channels[channel].lastVolume);
      } 
    }
  });
}

twitter.sayTweet = function (client, config, tweetMsg, tweetURL, tweetChannels) {
  var shortlinks = tweetMsg.match(/http:\/\/\S{3,10}\/\S{3,10}\b/ig);
  async.series({
    bitly : function (send) {
      if (twitter.bitly) {
        var tweetLink;
        twitter.bitly.shorten(tweetURL, function (result) {
          tweetLink = " (Tweet: " + result.data.url + ")";
          send(null, tweetLink);
        });
      }
      else {
        send(null, ' ');
      }
    },
    unshorten : function (send) {
      if (shortlinks != null) {
        shortlinks.forEach(function (shortlink, index) {
          unshortener.expand(shortlink, function (url) {
            if (url.href !== shortlink) {
              tweetMsg = tweetMsg.replace(shortlink, url.href);
              send(null, tweetMsg);
            }
          });
        });
      }
      else {
        send(null, tweetMsg);
      }
    }
  }, send);

  function send(err, results) {
    var finalMsg,
        found;
    if (err) { 
      return console.log(err);
    }
    finalMsg = results.unshorten;
    if (typeof results.bitly !== 'undefined') {
      finalMsg = finalMsg + results.bitly;
    }
    found = tweetMsg.match(match);
    while (found && (found.length > 0)) {
      config.plugins.twitter.recentUrls.push(found[0]);
      found.shift();
    }
    while (config.plugins.twitter.recentUrls.length > 100) {
      config.plugins.twitter.recentUrls.shift();
    }
    tweetChannels.forEach( function (channel) {
      client.say(channel, finalMsg);
      config.plugins.irc.channels[channel].currentTweetCount++;
    });
    config.plugins.twitter.recentTweets.push(tweetMsg);
    if (config.plugins.twitter.recentTweets.length > 100) {
      config.plugins.twitter.recentTweets.shift();
    }
    console.log(finalMsg);
  }
}