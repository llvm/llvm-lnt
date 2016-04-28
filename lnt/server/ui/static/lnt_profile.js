//////////////////////////////////////////////////////////////////////
// This script provides the functionality for the LNT profile page
// (v4_profile.html).


function CFGInstruction (weight, address, text) {
    this.address = address;
    this.text = text;
    this.weight = weight;
};

function CFGBasicBlock (instructions, fallThruInstruction, cfg) {
    this.cfg = cfg;
    this.instructionParser = this.cfg.instructionParser;
    this.instructions = instructions;
    this.address = instructions[0].address;
    var gjt = this.instructionParser
        .getJumpTargets(instructions[instructions.length-1], fallThruInstruction, this.cfg);
    this.targets = gjt[1];
    this.noFallThru = gjt[0];
    this.weight = this.instructions
        .reduce(function (a,b) {
            var weight_a = (a.weight === undefined)?a:a.weight;
            var weight_b = (b.weight === undefined)?b:b.weight;
            return weight_a+weight_b;
        }, 0);
};

function CFGEdge (bb_from, bb_to) {
    this.from = bb_from;
    this.to = bb_to;
};

function CFG (disassembly, instructionParser) {
    this.disassembly = disassembly;
    this.instructionParser = instructionParser;
    var instructions = this.parseDisassembly(this.disassembly);
    this.bbs = this.createBasicBlocks(instructions);
    // The special "UNKNOWN" basic block is used to represent jump targets for
    // which no corresponding basic block can be found. So, edges jumping to a
    // target that has no associated basic block will go to this "UNKNOWN"
    // basic block.
    this.UNKNOWN_BB = this.createUnknownBB();
    this.bbs.push(this.UNKNOWN_BB);
    this.address2bb = {};
    this.bb_incoming_edges = {};
    this.bb_outgoing_edges = {};
    this.edges = [];
    for (var i=0; i<this.bbs.length; ++i) {
        var bb = this.bbs[i];
        this.address2bb[bb.address] = bb;
    }
    var address2bb = this.address2bb;
    for (var i=0; i<this.bbs.length; ++i) {
        var bb = this.bbs[i];
        var target_bbs = bb.targets.map(function (a) { return address2bb[a]; });
        if (target_bbs.length == 0 &&
            !bb.noFallThru) {
            // this is a fall-thru-only BB.
            if (i+1<this.bbs.length)
                target_bbs = [this.bbs[i+1]];
        }
        for (var j=0; j<target_bbs.length; ++j) {
            var target_bb = target_bbs[j];
            // Jump to special "unknown bb" for jumps to an unknown basic block. 
            if (!target_bb)
                target_bb = this.UNKNOWN_BB;
            var edge = new CFGEdge(this.bbs[i], target_bb);
            this.edges.push(edge);
        }
    }
};

function InstructionSetParser (regexps) {
    this.jumpTargetRegexps = regexps;
};

InstructionSetParser.prototype = {
    AArch64JumpTargetRegexps: [
        // (regexp, noFallThru?)
        // branch conditional:
        [new RegExp("^\\s*b\\.[a-z]+\\s+([^\\s]+)"), false],
        // branch unconditional:
        [new RegExp("^\\s*b\\s+([^\\s]+)"), true],
        // cb(n)z
        [new RegExp("^\\s*cbn?z\\s+[^,]+,\\s*([^\\s]+)"), false],
        // ret
        [new RegExp("^\\s*ret"), true]
        // FIXME: also add tbz, ...
    ],

    AArch32T32JumpTargetRegexps: [
        // (regexp, noFallThru?)
        // branch conditional:
        [new RegExp("^\\s*b(?:(?:ne)|(?:eq)|(?:cs)|(?:cc)|(?:mi)|(?:pl)|(?:vs)|(?:vc)|(?:hi)|(?:ls)|(?:ge)|(?:lt)|(?:gt)|(?:le))(?:\\.[nw])?\\s+([^\\s]+)"), false],
        // branch unconditional:
        [new RegExp("^\\s*b(?:\\.[nw])?\\s+([^\\s]+)"), true],
        // cb(n)z
        [new RegExp("^\\s*cbn?z\\s+[^,]+,\\s*([^\\s]+)"), false]
        // TODO: add all control-flow-changing instructions.
    ],

    getJumpTargets: function(instruction, nextInstruction, cfg) {
        for(var i=0; i<this.jumpTargetRegexps.length; ++i) {
            var regexp = this.jumpTargetRegexps[i][0];
            var noFallThru = this.jumpTargetRegexps[i][1];
            var match = instruction.text.match(regexp);
            if (match) {
                var targets = [];
                if (!noFallThru && nextInstruction)
                    targets.push(nextInstruction.address);
                if (match.length > 1)
                    targets.push(cfg.convertToAddress(match[1]));
                return [noFallThru, targets];
            }
        }
        return [false, []];
    }
};


CFG.prototype = {
    // The following method will have different implementations depending
    // on the profiler, or kind of profiling input.
    convertToAddress: function (addressString) {
      return parseInt(addressString, 16);
    },

    parseDisassembly: function() {
        var instructions = [];
        for (var i=0; i<this.disassembly.length; ++i) {
            var profiled_instruction = this.disassembly[i];
            var counter2weight = profiled_instruction[0];
            var address = profiled_instruction[1];
            var text = profiled_instruction[2];
            // FIXME: strip leading white space from text?
            var cfgInstruction =
                new CFGInstruction(counter2weight['cycles'],
                                   address,
                                   text);
            instructions.push(cfgInstruction);
        }
        return instructions;
    },

    createBasicBlocks: function(instructions) {
        var bbstarts = {};
        for (var i=0; i<instructions.length; ++i) {
            var instruction = instructions[i];
            var nextInstruction = (i+1<instructions.length)?instructions[i+1]:null;
            var gjt = this.instructionParser
                .getJumpTargets(instruction, nextInstruction, this);
            var jumpTargets=gjt[1], noFallThru=gjt[0];
            if (jumpTargets.length > 0) {
                for(var j=0; j<jumpTargets.length; ++j) {
                    var jumpTarget = jumpTargets[j];
                    bbstarts[jumpTarget] = true;
                }
                if (nextInstruction) {
                    bbstarts[nextInstruction.address] = true;
                }
            }
        }
        // start creating basic blocks now:
        var bbs = [];
        var instructionsInCurrentBB = [];
        for (var i=0; i<instructions.length; ++i) {
            var instruction = instructions[i];
            if (bbstarts[instruction.address] && i > 0) {
                bbs.push(new CFGBasicBlock(instructionsInCurrentBB, instruction, this));
                instructionsInCurrentBB = [];
            }
            instructionsInCurrentBB.push(instruction);
        }
        bbs.push(new CFGBasicBlock(instructionsInCurrentBB, null,
                                   this));
        return bbs;
    },

    createUnknownBB: function() {
        var i = new CFGInstruction(0.0 /* weight */,
                                   "" /* address */,
                                   "UNKNOWN");
        return new CFGBasicBlock([i], null, this);
    }
};


function D3CFG (cfg) {
    this.cfg = cfg;
    this.d3bbs = [];
    this.bb2d3bb = new Map();
    this.d3edges = [];
    this.d3bbTopSlots = [];
    this.d3bbBotSlots = [];
    this.d3vlanes = [];
    this.vlane_occupancies = [];
    for (var bbi=0; bbi<this.cfg.bbs.length; ++bbi) {
        var bb = this.cfg.bbs[bbi];
        var d3bb = new D3BB(bb, bbi);
        this.d3bbs.push(d3bb);
        this.bb2d3bb.set(bb, d3bb);
    }
    for (var ei=0; ei<this.cfg.edges.length; ++ei) {
        var e = this.cfg.edges[ei];
        this.d3edges.push(new D3Edge(e, this));
    }
};

D3CFG.prototype = {
    compute_layout: function() {
        var offset = 0;
        for(var i=0; i<this.d3bbs.length; ++i) {
            var d3bb = this.d3bbs[i];
            d3bb.compute_layout(this);
            d3bb.y = d3bb.y + offset;
            offset += d3bb.height + this.bbgap;
        }
        for(var i=0; i<this.d3edges.length; ++i) {
            var d3e = this.d3edges[i];
            d3e.compute_layout_part1(this);
        }
        // heuristic: layout shorter edges first, so they remain closer to
        // the basic blocks.
        this.d3edges.sort(function (e1,e2) {
            var e1_length = Math.abs(e1.start_bb_index - e1.end_bb_index);
            var e2_length = Math.abs(e2.start_bb_index - e2.end_bb_index);
            return e1_length - e2_length;
        });
        for(var i=0; i<this.d3edges.length; ++i) {
            var d3e = this.d3edges[i];
            d3e.compute_layout_part2(this);
        }
        this.height = offset;
        this.vlane_width = this.vlane_gap * this.vlane_occupancies.length;
        this.vlane_offset = Math.max.apply(Math,
            this.d3bbs.map(function(i){return i.width;})) + this.vlane_gap;
        this.width = this.vlane_offset + this.vlane_width;
    },

    // layout parameters:
    vlane_gap: 10,
    bbgap: 15,
    instructionTextSize: 10,
    avgCharacterWidth: 6,
    bb_weight_width: 20,
    x_offset_instruction_text: 100+20/*bb_weight_width*/,
    slot_gap: 0
};

function D3BB (bb, index) {
    this.bb = bb;
    this.index = index;
    this.d3instructions = [];
    this.free_top_slot = 0;
    this.free_bottom_slot = 0;
    for (var i=0; i<this.bb.instructions.length; ++i) {
        var instr = this.bb.instructions[i];
        this.d3instructions.push(new D3Instruction(instr));
    }
};

D3BB.prototype = {
    compute_layout: function(d3cfg) {
        var offset = 0;
        this.d3instructions.forEach(function(d3i) {
            d3i.compute_layout(d3cfg);
            d3i.y = d3i.y + offset;
            offset += d3i.height + 1;
        });
        this.x = 0;
        this.y = 0;
        this.height = offset;
        this.width = Math.max.apply(Math,
            this.d3instructions.map(function(i){return i.width;}))
                                  + d3cfg.x_offset_instruction_text;
    },

    reserve_bottom_slot: function(d3cfg) {
        var offset = this.free_bottom_slot++;
        y_coord = this.y + this.height - (d3cfg.slot_gap*offset);
        return y_coord;
    },
    reserve_top_slot: function(d3cfg) {
        var offset = this.free_top_slot++;
        y_coord = this.y + (d3cfg.slot_gap*offset);
        return y_coord;
    }
};

function D3Edge (edge, d3cfg) {
    this.edge = edge;
    this.d3cfg = d3cfg;
};

D3Edge.prototype = {
    compute_layout_part1: function (d3cfg) {
        var bb_from = this.edge.from;
        var bb_to = this.edge.to;
        d3bb_from = this.d3cfg.bb2d3bb.get(bb_from);
        d3bb_to = this.d3cfg.bb2d3bb.get(bb_to);
        this.downward = d3bb_from.y < d3bb_to.y;
        if (this.downward) {
            this.start_bb_index = d3bb_from.index;
            this.end_bb_index = d3bb_to.index;
        } else {
            this.start_bb_index = d3bb_to.index;
            this.end_bb_index = d3bb_from.index;
        }
        this.fallthru = this.start_bb_index+1 == this.end_bb_index;
        if (this.fallthru) {
            this.start_y = d3bb_from.y + d3bb_from.height;
            this.end_y = d3bb_to.y;
            var x = Math.min(d3bb_from.width/2, d3bb_to.width/2);
            this.start_x = this.end_x = x;
            return;
        }
        this.start_y = d3bb_from.reserve_bottom_slot(d3cfg);
        this.end_y = d3bb_to.reserve_top_slot(d3cfg);
        this.start_x = d3bb_from.width;
        this.end_x = d3bb_to.width;
    },

    reserve_lane: function (lanenr) {
        var vlane_occupancy = this.d3cfg.vlane_occupancies[lanenr];
        if (this.downward) {
            vlane_occupancy[this.start_bb_index].bottom = this;
        } else {
            vlane_occupancy[this.start_bb_index].top = this;
        }
        for(var i=this.start_bb_index+1; i<this.end_bb_index; ++i) {
            vlane_occupancy[i].top = this;
            vlane_occupancy[i].bottom = this;
        }
        if (this.downward) {
            vlane_occupancy[this.end_bb_index].top = this;
        } else {
            vlane_occupancy[this.end_bb_index].bottom = this;
        }
        this.vlane = lanenr;
    },

    compute_layout_part2: function() {
        // special case for fall-thru: just draw a direct line.
        // reserve an edge connection slot at the top bb and the end bb
        // look for first vertical lane that's free across all basic blocks
        // this edge will cross, and reserve that.
        if (this.fall_thru)
            return;
        var available=false;
        iterate_vlanes_loop:
        for(var j=0; j<this.d3cfg.vlane_occupancies.length; ++j) {
            var vlane_occupancy = this.d3cfg.vlane_occupancies[j];
            available=true;
            if (this.downward) {
                if (vlane_occupancy[this.start_bb_index].bottom) {
                    available=false;
                    continue iterate_vlanes_loop;
                }
            } else {
                if (vlane_occupancy[this.start_bb_index].top) {
                    available=false;
                    continue iterate_vlanes_loop;
                }
            }
            for(var i=this.start_bb_index+1; i<this.end_bb_index; ++i) {
                if (vlane_occupancy[i].top || vlane_occupancy[i].bottom) {
                    // this vlane slot is already taken - continue looking
                    // in next vlane.
                    available = false;
                    continue iterate_vlanes_loop;
                }
            }
            if (this.downward) {
                if (vlane_occupancy[this.end_bb_index].top) {
                    available=false;
                    continue iterate_vlanes_loop;
                }
            } else {
                if (vlane_occupancy[this.end_bb_index].bottom) {
                    available=false;
                    continue iterate_vlanes_loop;
                }
            }
            // lane j is available for this edge:
            if (available) {
                this.reserve_lane(j);
                this.vlane=j;
                break iterate_vlanes_loop;
            }
        }
        if (!available) {
            // no vlane found, create a new one.
            this.d3cfg.vlane_occupancies.push(
                Array.apply(null,
                    Array(this.d3cfg.d3bbs.length)).map(function () {
                        o = new Object;
                        o.top = null;
                        o.bottom = null;
                        return o;
                    }));
            this.reserve_lane(this.d3cfg.vlane_occupancies.length-1);
        }
    }
};

function D3Instruction (cfgInstruction) {
    this.instruction = cfgInstruction;
};

D3Instruction.prototype = {
    compute_layout: function(d3cfg) {
        this.x = 0;
        this.y = 0;
        this.height = d3cfg.instructionTextSize;
        this.width = d3cfg.avgCharacterWidth*this.instruction.text.length;
    }
}

function Profile(element, runid, testid, unique_id) {
    this.element = $(element);
    this.runid = runid;
    this.testid = testid;
    this.unique_id = unique_id;
    this.function_name = null;
    $(element).html('<center><i>Select a run and function above<br> ' +
                    'to view a performance profile</i></center>');
}

function startsWith(string, startString) {
    return string.substr(0, startString.length) === startString;
}

Profile.prototype = {
    reset: function() {
        $(this.element).empty();
        $(this.element).html('<center><i>Select a run and function above<br> ' +
                             'to view a performance profile</i></center>');
    },
    go: function(function_name, counter_name, displayType, counterDisplayType,
                 total_ctr_for_fn) {
        this.counter_name = counter_name
        this.displayType = displayType;
        this.counterDisplayType = counterDisplayType;
        this.total_ctr = total_ctr_for_fn;
        if (this.function_name != function_name)
            this._fetch_and_display(function_name);
        else
            this._display();
    },

    _fetch_and_display: function(fname, then) {
        this.function_name = fname;
        var this_ = this;
        $.ajax(g_urls.getCodeForFunction, {
            dataType: "json",
            data: {'runid': this.runid, 'testid': this.testid,
                   'f': fname},
            success: function(data) {
                this_.data = data;
                this_._display();
            },
            error: function(xhr, textStatus, errorThrown) {
                pf_flash_error('accessing URL ' + g_urls.getCodeForFunction +
                               '; ' + errorThrown);
            }
        });
    },

    _display: function() {
        try {
            if (startsWith(this.displayType, 'cfg')) {
                var instructionSet = this.displayType.split('-')[1];
                this._display_cfg(instructionSet);
            } else
                this._display_straightline();
        }
        catch (err) {
            $(this.element).html(
                '<center><i>The javascript on this page to<br> ' +
                'analyze and visualize the profile has crashed:<br>'+
                +err.message+'</i></center>'+
                err.stack);
        }
    },

    _display_cfg: function(instructionSet) {
        this.instructionSet = instructionSet; 
        this.element.empty();
        var profiledDisassembly = this.data;
        var instructionParser;
        if (this.instructionSet == 'aarch64') 
            instructionParser = new InstructionSetParser(
                InstructionSetParser.prototype.AArch64JumpTargetRegexps);
        else if (this.instructionSet == 'aarch32t32')
            instructionParser = new InstructionSetParser(
                InstructionSetParser.prototype.AArch32T32JumpTargetRegexps);
        else {
            // Do not try to continue if we don't have support for
            // the requested instruction set.
            $(this.element).html(
                '<center><i>There is no support (yet?) for reconstructing ' +
                'the CFG for the<br>' +
                this.instructionSet+' instruction set. :(.</i></center>');
            return;
        }
        var cfg = new CFG(profiledDisassembly, instructionParser);
        var d3cfg = new D3CFG(cfg);
        d3cfg.compute_layout();
        var d3data = [d3cfg];
        var d3cfg_dom = d3.select(this.element.get(0))
            .selectAll("svg")
            .data(d3data)
            .enter().append("svg");
        var profile = this;

        // add circle and arrow marker definitions
        var svg_defs = d3cfg_dom.append("defs");
        svg_defs.append("marker")
            .attr("id", "markerCircle")
            .attr("markerWidth", "7").attr("markerHeight", "7")
            .attr("refX", "3").attr("refY", "3")
            .append("circle")
            .attr("cx","3").attr("cy", "3").attr("r","3")
            .attr("style","stroke: none; fill: #000000;");
        svg_defs.append("marker")
            .attr("id", "markerArrow")
            .attr("markerWidth", "11").attr("markerHeight", "7")
            .attr("refX", "10").attr("refY", "3")
            .attr("orient", "auto")
            .append("path")
            .attr("d","M0,0 L0,6 L10,3 L0,0")
            .attr("style","fill: #000000;");
        d3cfg_dom
            .attr('width', d3data[0].width)
            .attr('height', d3data[0].height);
        var d3bbs_dom = d3cfg_dom.selectAll("g .bbgroup")
            .data(function (d,i) { return d.d3bbs; })
            .enter().append("g").attr('class', 'bbgroup');
        d3bbs_dom
            .attr("transform", function (d) {
              return "translate(" + d.x + "," + d.y + ")"});
        d3bbs_dom.append("rect")
            .attr('class', 'basicblock')
            .attr("x", function(d) { return d3cfg.bb_weight_width; })
            .attr("y", function (d) { return 0; })
            .attr("height", function (d) { return d.height; })
            .attr("width", function (d) {
                return d.width-d3cfg.bb_weight_width; });
        // draw weight of basic block in a rectangle on the left.
        d3bbs_dom.append("rect")
            .attr('class', 'basicblocksidebar')
            .attr("x", function(d) { return 0; })
            .attr("y", function (d) { return 0; })
            .attr("height", function (d) { return d.height; })
            .attr("width", function (d) { return d3cfg.bb_weight_width; })
            .attr("style", function (d) {
                var lData = profile._label(d.bb.weight, true /*littleSpace*/);
                return "fill: "+lData.background_color;
            });
        d3bbs_dom.append("g")
            .attr('transform', function (d) {
                return "translate("
                    +(d.x+d3cfg.bb_weight_width-3)
                    +","
                    +(d.height/2)
                    +")"; })
            .append("text")
            .attr('class', 'basicblockweight')
            .attr("transform", "rotate(-90)")
            .attr("text-anchor", "middle")
            .text(function (d,i) {
                var lData = profile._label(d.bb.weight, true /*littleSpace*/);
                return lData.text; //d.bb.weight.toFixed(0)+"%"; 
            });
        var d3inst_dom = d3bbs_dom.selectAll("text:root")
            .data(function (d,i) { return d.d3instructions; })
            .enter();
        // draw disassembly text
        d3inst_dom.append("text")
            .attr('class', 'instruction instructiontext')
            .attr("x", function (d,i) { return d.x+d3cfg.x_offset_instruction_text; })
            .attr("y", function (d,i) { return d.y+10; })
            .text(function (d,i) { return d.instruction.text; });
        // draw address of instruction
        d3inst_dom.append("text")
            .attr('class', 'instruction instructionaddress')
            .attr("x", function (d,i) { return d.x+d3cfg.bb_weight_width+50; })
            .attr("y", function (d,i) { return d.y+10; })
            .text(function (d,i) { return d.instruction.address.toString(16); });
        // draw profile weight of instruction
        d3inst_dom.append("text")
            .attr('class', 'instruction instructionweight')
            .attr("x", function (d,i) { return d.x+d3cfg.bb_weight_width+0; })
            .attr("y", function (d,i) { return d.y+10; })
            .text(function (d,i) {
                if (d.instruction.weight == 0)
                    return "";
                else
                    return d.instruction.weight.toFixed(2)+"%";
                });
        var d3edges_dom = d3cfg_dom.selectAll("g .edgegroup")
            .data(function (d,i) { return d.d3edges; })
            .enter().append("g").attr('class', 'edgegroup');
        d3edges_dom.append("polyline")
            .attr("points", function (d,i) {
                if (d.fallthru) {
                    return d.start_x+","+d.start_y+" "+
                           d.end_x+","+d.end_y;
                }
                var lane_x = d.d3cfg.vlane_offset + d.d3cfg.vlane_gap*d.vlane;
                return d.start_x+","+d.start_y+" "+
                       lane_x+","+d.start_y+" "+
                       lane_x+","+d.end_y+" "+
                       d.end_x+","+d.end_y; })
            .attr('class', function (d) {
                return d.downward?'edge':'backedge';
            })
            .attr('style',
                  'marker-start: url(#markerCircle); '+
                  'marker-end: url(#markerArrow);');
    },

    _display_straightline: function() {
        this.element.empty();
        this.cumulative = 0;
        for (var i=0; i<this.data.length; ++i) {
            line = this.data[i];

            row = $('<tr></tr>');

            counter = this.counter_name;
            if (counter in line[0] && line[0][counter] > 0.0)
                row.append(this._labelTd(line[0][counter]));
            else
                row.append($('<td></td>'));

            address = line[1].toString(16);
            id = this.unique_id + address;
            a = $('<a id="' + id + '" href="#' + id + '"></a>').text(address);
            row.append($('<td></td>').addClass('address').append(a));
            row.append($('<td></td>').text(line[2]));
            this.element.append(row);
        }
    },

    _label: function(value, littleSpace) {
        var this_ = this;
        var labelPct = function(value) {
            // Colour scheme: Black up until 1%, then yellow fading to red at 10%
            var bg = '#fff';
            var hl = '#fff';
            if (value > 1.0 && value < 10.0) {
                hue = lerp(50.0, 0.0, (value - 1.0) / 9.0);
                bg = 'hsl(' + hue.toFixed(0) + ', 100%, 50%)';
                hl = 'hsl(' + hue.toFixed(0) + ', 100%, 30%)';
            } else if (value >= 10.0) {
                bg = 'hsl(0, 100%, 50%)';
                hl = 'hsl(0, 100%, 30%)';
            }
            return {
              background_color: bg,
              border_right_color: hl,
              text: (value.toFixed(littleSpace?0:2) + '%')
            };
        };
        
        var labelAbs = function(value) {
            // Colour scheme: Black up until 1%, then yellow fading to red at 10%
            var bg = '#fff';
            var hl = '#fff';
            if (value > 1.0 && value < 10.0) {
                hue = lerp(50.0, 0.0, (value - 1.0) / 9.0);
                bg = 'hsl(' + hue.toFixed(0) + ', 100%, 50%)';
                hl = 'hsl(' + hue.toFixed(0) + ', 100%, 30%)';
            } else if (value >= 10.0) {
                bg = 'hsl(0, 100%, 50%)';
                hl = 'hsl(0, 100%, 30%)';
            }

            var absVal = (value / 100.0) * this_.total_ctr;
            return {
              background_color: bg,
              border_right_color: hl,
              text: (currencyify(absVal)),
              absVal: absVal
            };
        };

        var labelCumAbs = function(value) {
            this_.cumulative += value;

            var hue = lerp(50.0, 0.0, this_.cumulative / 100.0);
            var bg = 'hsl(' + hue.toFixed(0) + ', 100%, 50%)';
            var hl = 'hsl(' + hue.toFixed(0) + ', 100%, 40%)';

            var absVal = (this_.cumulative / 100.0) * this_.total_ctr;
            return {
              background_color: bg,
              border_right_color: hl,
              text: (currencyify(absVal)),
              cumulative: this_.cumulative,
              absVal: absVal
            };
        }

        if (this.counterDisplayType == 'cumulative')
            return labelCumAbs(value);
        else if (this.counterDisplayType == 'absolute')
            return labelAbs(value);
        else
            return labelPct(value);
    },

    _labelTd: function(value) {
        var this_ = this;
        var labelPct = function(value, bg, hl, text) {
            return $('<td style="background-color:' + bg + '; border-right: 1px solid ' + hl + ';"></td>')
                .text(text);
        };
        
        var labelAbs = function(value, bg, hl, text, absVal) {
            return $('<td style="background-color:' + bg + '; border-right: 1px solid ' + hl + ';"></td>')
                .text(currencyify(absVal))
                .append($('<span></span>')
                        .text(value.toFixed(2) + '%')
                        .hide());
        };

        var labelCumAbs = function(value, bg, hl, text, cumulative) {
            return $('<td style="border-right: 1px solid ' + hl + ';"></td>')
                .css({color: 'gray', position: 'relative'})
                .text(text)
                .append($('<span></span>')
                        .text(value.toFixed(2) + '%')
                        .hide())
                .append($('<span></span>')
                        .css({
                            position: 'absolute',
                            bottom: '0px',
                            left: '0px',
                            width: cumulative + '%',
                            height: '2px',
                            border: '1px solid ' + hl,
                            backgroundColor: bg
                        }));
        }

        var lData = this._label(value, false /*littleSpace*/);
        if (this.counterDisplayType == 'cumulative')
            return labelCumAbs(value,
                               lData.background_color,
                               lData.border_right_color,
                               lData.text,
                               lData.cumulative);
        else if (this.counterDisplayType == 'absolute')
            return labelAbs(value,
                            lData.background_color,
                            lData.border_right_color,
                            lData.text,
                            lData.absVal);
        else
            return labelPct(value,
                            lData.background_color,
                            lData.border_right_color,
                            lData.text);
    }
};

function StatsBar(element, testid) {
    this.element = $(element);
    this.runid = null;
    this.testid = testid;

    $(element).html('<center><i>Select one or two runs above ' +
                    'to view performance counters</i></center>');
}

StatsBar.prototype = {
    go: function (runids) {
        if (runids == this.runids)
            return;
        this.runids = runids;
        this.element.empty();
        var this_ = this;
        
        $.ajax(g_urls.getTopLevelCounters, {
            dataType: "json",
            data: {'runids': this.runids.join(), 'testid': this.testid},
            success: function(data) {
                this_.data = data;
                var t = $('<table></table>').addClass('table table-striped table-condensed table-hover');
                this_.element.html(t);

                var gdata = [];
                var ticks = [];
                var i = 0;
                var n = 0;
                for (counter in data)
                    ++n;
                for (counter in data) {
                    var barvalue = data[counter][0] - data[counter][1];
                    var percent = (barvalue / data[counter][0]) * 100;
                    
                    var r = $('<tr></tr>');
                 
                    r.append($('<th>' + counter + '</th>').addClass('span2'));
                    r.append($('<td></td>').append(this_._formatValue(data[counter][0]))
                             .addClass('span4')
                             .css({'text-align': 'right'}));
                    r.append($('<td></td>').append(this_._formatValue(data[counter][1]))
                             .addClass('span2')
                             .css({'text-align': 'left'}));
                    r.append($('<td></td>').append(this_._formatPercentage(percent))
                             .addClass('span1')
                             .css({'text-align': 'right'}));
                    t.append(r);

                    var color = 'red';
                    if (barvalue < 0)
                        color = 'green';

                    gdata.push({data: [[percent, n - i]], color: color});
                    ticks.push([i, counter]);
                    ++i;
                }

                $('#stats-graph').height(this_.element.height());
                $.plot('#stats-graph', gdata, {
                    series: {
                        bars: {
                            show: true,
                            barWidth: 0.6,
                            align: "center",
                            horizontal: true
                        }
                    },
                    xaxis: {
                        tickFormatter: function(f) {
                            return this_._percentageify(f);
                        },
                        autoscaleMargin: 0.05
                    },
                    yaxis: {
                        show: false
                    },
                    grid: {
                        borderWidth: 0
                    }
                });

                $('#toolbar').toolBar().triggerResize();
            },
            error: function(xhr, textStatus, errorThrown) {
                pf_flash_error('accessing URL ' + g_urls.getTopLevelCounters +
                               '; ' + errorThrown);
            }
        });

    },

    getCounterValue: function(counter) {
        return this.data[counter];
    },

    _percentageify: function(value) {
        return value.toFixed(0) + '%';
    },
    
    _formatPercentage: function(value) {
        if (!value)
            return "";

        var color;
        if (value > 0)
            color = 'red';
        else
            color = 'green';

        var f = value.toFixed(2);
        if (f > 0)
            f = '+' + f;
        
        var s = $('<span></span>').text(f + '%');
        s.css({color: color});
        return s;
    },
    
    _formatValue: function(value) {
        if (!value)
            return "";
        var s = '<span data-toggle="tooltip" title="' + add_commas(value) + '">';
        s += currencyify(value);
        s += '</span>';

        return $(s).tooltip();
    }
};

function ToolBar(element) {
    this.element = $(element);
    var this_ = this;

    // We want the toolbar to "stick" just below the main nav, which is fixed.
    // However, on narrow screens the main nav is not fixed. So detect that here.
    if ($('#header').css('position') == 'fixed') {
        // There is some weird padding issue where $(#header).height() is not the
        // same as $(#header ul).top + $(#header ul).height. The header height
        // somehow has about 4px more. Use the ul here.
        var obj = $('#header .breadcrumb');
        this.marginTop = obj.position().top + obj.innerHeight();
    } else {
        this.marginTop = 0;
    }
    
    var marginLeft;
    var marginRight;
    // We use the jQuery plugin "scrollToFixed" which can do everything we want.
    $(element).scrollToFixed({
        marginTop: this.marginTop,
        // But, our toolbar is a row inside a container-fluid, and depending on the
        // screen width this can contain negative margins. These margins differ too
        // on the screen size. Once the element is fixed, those negative margins no longer
        // just cancel out the padding in #container-fluid, and the bar appears off
        // the screen.
        //
        // So here, first save the current margins...
        preFixed: function() {
            marginLeft = parseInt(element.css('marginLeft'));
            marginRight = parseInt(element.css('marginRight'));
        },
        // ... Then set the left margin back to zero, and the width to 100% AFTER
        // position: fixed has been set! (because width is overridden by scrollToFixed).
        fixed: function() {
            element.css({marginLeft: 0, width: '100%'});
        },
        // Then when we revert to relative positioning, restore the correct margins.
        postFixed: function() {
            element.css({marginLeft: marginLeft, marginRight: marginRight});
        }
    });
    
    var this_ = this;
    element.find('.next-btn-l').click(function() {
      this_._findNextInstruction(this_, false);
    });
    element.find('.prev-btn-l').click(function() {
      this_._findNextInstruction(this_, true);
    });
}

ToolBar.prototype = {
    _findNearestInstructionInProfile: function(this_, profile_elem_name) {
        var windowTop = $(window).scrollTop();
        var offset = this_.marginTop + this.element.innerHeight();

        var y = windowTop + offset;
        var ret = null;
        $('#' + profile_elem_name + ' a').each(function(idx, obj) {
            var objY = $(obj).position().top;
            if (objY > y) {
                ret = obj;
                return false;
            }
        });
        return ret;
    },

    _findNextInstructionInProfile: function(this_, profile_elem_name, isPrev) {
        var inst_a = this_._findNearestInstructionInProfile(this_, profile_elem_name);
        var inst_tr = $(inst_a).closest('tr');

        var ret = null;
        var selector = isPrev ? inst_tr.prevAll('tr') : inst_tr.nextAll('tr');
        selector.each(function(idx, obj) {
            var counter = $(obj).children('td').first().text();
            var s = $(obj).children('td').first().children('span');
            if (s.length)
                counter = s.first().text();

            if (counter.length == 0)
                return;
            var c = parseFloat(counter);
            if (!c || c < 5.0)
                return;

            ret = obj;
            return false;
        });
        return ret;
    },

    _findNextInstruction: function(this_, isPrev) {
        var offset = this_.marginTop + this.element.innerHeight();

        var ret1 = this_._findNextInstructionInProfile(this_, 'profile1', isPrev);
        var ret2 = this_._findNextInstructionInProfile(this_, 'profile2', isPrev);

        var obj = ret1;
        if (ret1 && ret2 && $(ret2).position().top < $(ret1).position().top)
            obj = ret2;
        else if (!ret1)
            obj = ret2;
        
        $('html, body').animate({
            scrollTop: $(obj).position().top - offset
        }, 500);
        
        $(obj).effect("highlight", {}, 1500);        
    },

    triggerResize: function() {
        $(window).trigger('resize.ScrollToFixed');
    }
};

function FunctionTypeahead(element, options) {
    this.element = element;
    this.options = options;
    var _this = this;
    
    element.typeahead({
            minLength: 0,
            items: 64,
        source: _this._source,
        matcher: function(item) {
            // This is basically the same as typeahead.matcher(), apart
            // from indexing into item[0] (as item is a 2-tuple
            //  [name, obj]).
            return item[0].toLowerCase().indexOf(this.query) > -1;
        },
        sorter: function(items) {
            // Sort items in descending order based on the value of the
            // current counter.

            c = options.getCounter();
            return items.sort(function(a, b) {
                // Note that this comparator needs to return -ve, 0, +ve,
                // NOT boolean. Therefore subtracting one from the other
                // gives the desired effect.
                var aval = -1; // Make sure undefined values get sorted
                var bval = -1; // to the end.
                if ('counters' in a[1] && c in a[1].counters) {
                    aval = a[1].counters[c];
                }  
                if ('counters' in b[1] && c in b[1].counters) {
                    bval = b[1].counters[c];
                }
                return bval - aval;
            });
            return items;
        },
        updater: function(item) {
            // FIXME: the item isn't passed in as json any more, it's
            // been rendered. Lame. Hack around this by splitting apart
            // the ','-concatenated 2-tuple again.
            fname = item.split(',')[0];

            options.updated(fname);
            return fname;
        },
        highlighter: function(item) {
            // Highlighting functions is a bit arduous - do it in
            // a helper function instead.
            return _this._renderItem(item, this.query);
        }
    });
    // A typeahead box will normally only offer suggestions when the input
    // is non-empty (at least one character).
    //
    // As we want to provide a view on the functions without having to
    // type anything (enumerate functions), add a focus handler to show
    // the dropdown.
    element.focus(function() {
        // If the box is not empty, do nothing to avoid getting in the
        // way of typeahead's own handlers.
        if (!element.data().typeahead.$element.val())
            element.data().typeahead.lookup();
    });
    // Given the above, this is a copy of typeahead.lookup() but with
    // a check for "this.query != ''" removed, so lookups occur even with
    // empty queries.
    element.data().typeahead.lookup = function (event) {
        this.query = this.$element.val();

        var items = $.isFunction(this.source)
            ? this.source(this.query, $.proxy(this.process, this))
            : this.source;
        
        return items ? this.process(items) : this;
    };
}

FunctionTypeahead.prototype = {
    update: function (name) {
        this.element.val(name);
        if (this.options.updated)
            this.options.updated(name);
    },
    changeSourceRun: function(rid, tid) {
        var this_ = this;
        $.ajax(g_urls.getFunctions, {
            dataType: "json",
            data: {'runid': rid, 'testid': tid},
            success: function(data) {
                this_.data = data;

                if (this_.options.sourceRunUpdated)
                    this_.options.sourceRunUpdated(data);
            },
            error: function(xhr, textStatus, errorThrown) {
                pf_flash_error('accessing URL ' + g_urls.getFunctions +
                               '; ' + errorThrown);
            }
        });
    },
    getFunctionPercentage: function(fname) {
        var this_ = this;
        var ret = null;
        $.each(this.data, function(idx, obj) {
            if (obj[0] == fname)
                ret = obj[1].counters[this_.options.getCounter()];
        });
        return ret;
    },
    _source: function () {
        return this.$element.data('functionTypeahead').data;
    },
    _renderItem: function (fn, query) {
        // Given a function name and the current query, return HTML for putting in
        // the function list dropdown.
        name = fn[0];
        counters = fn[1].counters;

        selected_ctr = this.options.getCounter();
        if (counters && selected_ctr in counters) {
            // We have counter information, so show it as a badge.
            //
            // Make the badge's background color depend on the counter %age.
            var value = counters[selected_ctr];

            var bg = '#fff';
            var hue = lerp(50.0, 0.0, value / 100.0);

            bg = 'hsl(' + hue.toFixed(0) + ', 100%, 50%)';

            counter_txt = '<span class="label label-inverse pull-left" ' +
                'style="background-color:' + bg + '; text-align: center; width: 40px; margin-right: 10px;">' + value.toFixed(1) + '%</span>';
        } else {
            // We don't have counter information :(
            counter_txt = '<span class="label label-inverse pull-left" style="text-align: center; width: 40%; margin-right: 10px;">'
                + '<i>no data</i></span>';
        }

        // This regex and code is taken from typeahead.highlighter(). If I knew
        // how to call typeahead.highlighter() from here, I would.
        var q = query.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, '\\$&')
        name_txt = name.replace(new RegExp('(' + q + ')', 'ig'), function ($1, match) {
            return '<strong>' + match + '</strong>'
        });
    
        return name_txt + counter_txt;
    }
};

$(document).ready(function () {
    jQuery.fn.extend({
        profile: function(arg1, arg2, arg3, arg4, arg5, arg6) {
            if (arg1 == 'go')
                this.data('profile').go(arg2, arg3, arg4, arg5, arg6);
            else if (arg1 && !arg2)
                this.data('profile',
                          new Profile(this,
                                      arg1.runid,
                                      arg1.testid,
                                      arg1.uniqueid));
            
            return this.data('profile');
        },
        statsBar: function(arg1, arg2) {
            if (arg1 == 'go')
                this.data('statsBar').go(arg2);
            else if (arg1 && !arg2)
                this.data('statsBar',
                          new StatsBar(this,
                                      arg1.testid));
            
            return this.data('statsBar');
        },
        toolBar: function() {
            if (!this.data('toolBar'))
                this.data('toolBar',
                          new ToolBar(this));
            
            return this.data('toolBar');
        },
        functionTypeahead: function(options) {
            if (options)
                this.data('functionTypeahead',
                          new FunctionTypeahead(this, options));
            return this.data('functionTypeahead');
        }

    });
});

//////////////////////////////////////////////////////////////////////
// Global variables

// A dict of URLs we want to AJAX to, by some identifying key. This allows
// us to use v4_url_for() in profile_views.py and propagate that down to
// JS without hackery.
var g_urls;
// The test ID - this remains constant.
var g_testid;

// pf_make_stub: Given a machine name and run order, make the stub
// that goes in the "run" box (machine #order).
function pf_make_stub(machine, order) {
    return machine + " #" + order
}

// pf_init: Called with the request parameters to initialize the page.
// This not only sets up defaults but also sets up the typeahead instances.
function pf_init(run1, run2, testid, urls) {
    g_urls = urls;

    $('#fn1_box')
        .prop('disabled', true)
        .functionTypeahead({
            getCounter: function() {
                return pf_get_counter();
            },
            updated: function(fname) {
                var fn_percentage = $('#fn1_box').functionTypeahead().getFunctionPercentage(fname) / 100.0;
                var ctr_value = $('#stats').statsBar().getCounterValue(pf_get_counter())[0];
                $('#profile1').profile('go', fname,
                                       pf_get_counter(), pf_get_display_type(),
                                       pf_get_counter_display_type(),
                                       fn_percentage * ctr_value);
            },
            sourceRunUpdated: function(data) {
                pf_set_default_counter(data);

                var r1 = $('#run1_box').runTypeahead().getSelectedRunId();
                var r2 = $('#run2_box').runTypeahead().getSelectedRunId();
                var ids = [];
                if (r1)
                    ids.push(r1);
                if (r2)
                    ids.push(r2);
                
                $('#fn1_box').prop('disabled', false);
                $('#stats')
                    .statsBar({testid: testid})
                    .go(ids);
                $('#profile1').profile({runid: r1,
                                        testid: testid,
                                        uniqueid: 'l'});
            }
        });

    $('#fn2_box')
        .prop('disabled', true)
        .functionTypeahead({
            getCounter: function() {
                return pf_get_counter();
            },
            updated: function(fname) {
                var fn_percentage = $('#fn2_box').functionTypeahead().getFunctionPercentage(fname) / 100.0;
                var ctr_value = $('#stats').statsBar().getCounterValue(pf_get_counter())[1];
                $('#profile2').profile('go', fname,
                                       pf_get_counter(), pf_get_display_type(),
                                       pf_get_counter_display_type(),
                                       fn_percentage * ctr_value);
            },
            sourceRunUpdated: function(data) {
                pf_set_default_counter(data);

                var r1 = $('#run1_box').runTypeahead().getSelectedRunId();
                var r2 = $('#run2_box').runTypeahead().getSelectedRunId();
                var ids = [];
                if (r1)
                    ids.push(r1);
                if (r2)
                    ids.push(r2);

                $('#fn2_box').prop('disabled', false);
                $('#stats')
                    .statsBar({testid: testid})
                    .go(ids);
                $('#profile2').profile({runid: r2,
                                        testid: testid,
                                        uniqueid: 'r'});

            }
        });
    
    var r1 = $('#run1_box')
        .runTypeahead({
            searchURL: g_urls.search,
            updated: function(name, id) {
                // Kick the functions dropdown to repopulate.
                $('#fn1_box')
                    .functionTypeahead()
                    .changeSourceRun(id, testid);
                pf_update_history();
            },
            cleared: function(name, id) {
                $('#fn1_box').val('').prop('disabled', true);
                $('#profile1').profile().reset();
            }
        });

    var r2 = $('#run2_box')
        .runTypeahead({
            searchURL: g_urls.search,
            updated: function(name, id) {
                // Kick the functions dropdown to repopulate.
                $('#fn2_box')
                    .functionTypeahead()
                    .changeSourceRun(id, testid);
                pf_update_history();
            },
            cleared: function(name, id) {
                $('#fn2_box').val('').prop('disabled', true);
                $('#profile2').profile().reset();
            }
        });

    r1.update(pf_make_stub(run1.machine, run1.order), run1.id);
    if (!$.isEmptyObject(run2))
        r2.update(pf_make_stub(run2.machine, run2.order), run2.id);

    $('#toolbar')
        .toolBar();

    
    // Bind change events for the counter dropdown so that profiles are
    // updated when it is modified.
    $('#view, #counters, #absolute').change(function () {
        g_counter = $('#counters').val();
        if ($('#fn1_box').val()) {
            var fn_percentage = $('#fn1_box').functionTypeahead().getFunctionPercentage(fname) / 100.0;
            var ctr_value = $('#stats').statsBar().getCounterValue(pf_get_counter())[0];
            $('#profile1').profile('go', $('#fn1_box').val(), g_counter,
                                   pf_get_display_type(),
                                   pf_get_counter_display_type(),
                                   fn_percentage * ctr_value);
        }
        if ($('#fn2_box').val()) {
            var fn_percentage = $('#fn2_box').functionTypeahead().getFunctionPercentage(fname) / 100.0;
            var ctr_value = $('#stats').statsBar().getCounterValue(pf_get_counter())[1];
            $('#profile2').profile('go', $('#fn2_box').val(), g_counter, 
                                   pf_get_display_type(),
                                   pf_get_counter_display_type(),
                                   fn_percentage * ctr_value);
        }
    });

    // FIXME: Implement navigating to an address properly.
    // var go_to_hash = function () {
    //     s = document.location.hash.substring(1);

    //     var element = $('#address' + s);
    //     var header_offset = $('#header').height();
    //     $('html, body').animate({
    //         scrollTop: element.offset().top - header_offset
    //     }, 500);
    // };
}

var g_throbber_count = 0;
// pf_ajax_takeoff - An ajax request has started. Show the throbber if it
// wasn't shown before.
function pf_ajax_takeoff() {
    g_throbber_count ++;
    if (g_throbber_count == 1) {
        $('#throbber').show();
    }
}
// pf_ajax_land - An ajax request has finished (success or failure). If
// there are no more ajax requests in flight (flight! get it? take off,
// land? ha!), hide the throbber.
function pf_ajax_land() {
    g_throbber_count --;
    if (g_throbber_count == 0) {
        $('#throbber').hide();
    }
}

// pf_flash_error - show an error message, dismissable by the user.
function pf_flash_error(msg) {
    txt = '<div class="alert alert-error">' +
        '<button type="button" class="close" data-dismiss="alert">&times;</button>' +
        '<strong>Error</strong> ' + msg + '</div>';
    $('#flashes').append(txt);
}

// pf_flash_warning - show a warning message, dismissable by the user.
function pf_flash_warning(msg) {
    txt = '<div class="alert">' +
        '<button type="button" class="close" data-dismiss="alert">&times;</button>' +
        '<strong>Warning</strong> ' + msg + '</div>';
    $('#flashes').append(txt);
}

var g_counter;
var g_all_counters = [];
// FIXME: misnomer?
// pf_set_default_counter - set g_all_counters to all unique performance
// counters found in 'data'.
//
// If g_counter is not yet set, select a default counter and set it.
function pf_set_default_counter(data) {

    var all_counters = g_all_counters.slice(); // Copy
    // Ghetto solution for creating a set. ES5 Set doesn't appear to be
    // available on Chrome yet.
    for (i in data) {
        f = data[i][1];
        for (j in f.counters) {
            all_counters.push(j);
        }
    }
    // FIXME: Replace with a sort_and_unique() method? that'd be more
    // efficient.
    all_counters = unique_array(all_counters);
    all_counters.sort();

    // Only perform any updates if the counters have changed.
    if (g_all_counters != all_counters) {
        // Blow away all previous counter options and re-add them.
        box = $('#counters').empty();
        for (i in all_counters) {
            var ctr = all_counters[i];
            box.append(
                $('<option></option>').text(ctr)
            );
        }
        // Re-select the previous value if it existed.
        if (g_counter != null) {
            box.val(g_counter);
        }

        g_all_counters = all_counters;
    }
    
    if (g_counter == null) {
        // Select a default. If 'cycles' exists, we pick that, else we
        // pick the first we see.
        if (g_all_counters.indexOf('cycles') != -1)
            g_counter = 'cycles';
        else
            g_counter = g_all_counters[0];
        $('#counters').val(g_counter);
    }
}

// pf_get_counter - Poor encapsulation of the g_counter object.
function pf_get_counter() {
    return g_counter;
}

// pf_get_counter_display_type - Whether we should display absolute values or percentages.
function pf_get_counter_display_type() {
    return $('#absolute').val();
}

// pf_get_display_type - Whether we should display straight-line profiles
// or control flow graphs.
function pf_get_display_type() {
    return $('#view').val();
}

// pf_update_history - Push a new history entry, as we've just navigated
// to what could be a new bookmarkable page.
function pf_update_history() {
    // FIXME: g_runids is no longer available.
    // var url;
    // if (g_runids[1]) {
    //     url = g_urls.comparison_template
    //         .replace('<testid>', g_testid)
    //         .replace('<run1id>', g_runids[0])
    //         .replace('<run2id>', g_runids[1]);
    // } else {
    //     url = g_urls.singlerun_template
    //         .replace('<testid>', g_testid)
    //         .replace('<run1id>', g_runids[0]);
    // }
    // history.pushState({}, document.title, url);
}

//////////////////////////////////////////////////////////////////////
// Helper functions

function unique_array(a) {
    var unique = [];
    for (var i = 0; i < a.length; i++) {
        if (unique.indexOf(a[i]) == -1) {
            unique.push(a[i]);
        }
    }
    return unique;
}

function add_commas(nStr) {
    nStr += '';
    x = nStr.split('.');
    x1 = x[0];
    x2 = x.length > 1 ? '.' + x[1] : '';
    var rgx = /(\d+)(\d{3})/;
    while (rgx.test(x1)) {
        x1 = x1.replace(rgx, '$1' + ',' + '$2');
    }
    return x1 + x2;
}

function currencyify(value, significant_figures) {
    if (!significant_figures)
        significant_figures = 3;
    value = value.toPrecision(significant_figures);

    var SI = ["K", "M", "Bn", "Tn"];
    SI.reverse();

    for (i in SI) {
        var multiplier = Math.pow(10, 3 * (SI.length - i));
        if (Math.abs(value) > multiplier)
            return (value / multiplier) + " " + SI[i];
    }
    return "" + value;
}
    
function lerp(s, e, x) {
    return s + (e - s) * x;
}
